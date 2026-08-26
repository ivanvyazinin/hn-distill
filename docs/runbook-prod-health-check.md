# Runbook: health-check прода

**Появился после:** 26.08.2026 — CI был 8/8 зелёный, а пользователь руками нашёл
22 карточки без суммаризации. Урок: валидатор по дизайну **молча** отбрасывает брак,
карточка тихо падает в запасной рендер, пайплайн остаётся зелёным. Поэтому чек =
три слоя, а не только статусы ранов.

## 1. Пайплайн (механика)

```sh
gh run list --workflow=hourly-build.yml --limit 8 \
  --json conclusion,createdAt --template '{{range .}}{{.createdAt}} {{.conclusion}}
{{end}}'
gh run list --workflow=daily-catchup.yml --limit 1 --json conclusion --jq '.[0].conclusion'
```

Все `success`? Нет — смотреть лог упавшего рана до выводов.

## 2. Семантические WARN за окно (качество генерации)

Статусы не показывают брак — он гасится валидатором и остаётся только в логах.

```sh
for rid in $(gh run list --workflow=hourly-build.yml --limit 8 --json databaseId --jq '.[].databaseId'); do
  gh run view "$rid" --log 2>/dev/null
done | grep -oE 'Comments (compress|v2)[^:{]*(reject|error|failed|written)|reason: '\''?[a-z_]+'\'?' \
  | sort | uniq -c | sort -rn
```

Интерпретация:

| сигнал | значение |
|---|---|
| `semantic reject expanded:N>M` у одних и тех же id в разных ранах | модель сжатия **не сжимает** — менять `COMMENTS_COMPRESS_MODEL`, не ждать (кейс 26.08: nematron :free жёг бюджет в reasoning и раздувал текст) |
| `transport error … empty content` / `permanent HTTP error` | слот модели болен или умер; проверить живость пробником |
| `insights failed heuristics { refusal }` | stage-1 модель отказывается отвечать — кандидат на ротацию |
| единичные reject'ы разных id | норма: гейт работает |

Правило: любой WARN, который «штатный», но повторяется по одним и тем же id — это
не штатное поведение, а застрявшее состояние. Разобраться до того, как оно станет
юзер-репортом.

## 3. Проба рендера (то, что реально видит юзер)

Взять ~10 item id с главной, скачать страницы, классифицировать comments-карточку:

```python
# compressed = один абзац (норма); bullets = fallback (compress absent/rejected)
import re, html, urllib.request
ids = [...]  # с главной: href="/hn-distill/item/<id>/"
for sid in ids:
    s = urllib.request.urlopen(f"https://ivanvyazinin.github.io/hn-distill/item/{sid}/").read().decode()
    seg = s[re.search(r'Комментарии \(\d+\)', s).end():]
    seg = seg[:seg.find('</aside>')]
    body = re.search(r'<div class="md">(.*?)</div>', seg, re.S).group(1)
    paras = len(re.findall(r'<p[ >]', body))
    print(sid, "COMPRESSED" if paras <= 1 else f"FALLBACK ({paras} paras)")
```

Порог: fallback > ~10% выборки = деградация compress-роута. Заодно глазами: в
fallback-карточках не должно быть простыни однотипных меток («Спор:… Спор:…») —
это значит stage-1 модель злоупотребляет kind (лечится демоцией в
`evaluateCommentsInsightsCandidate`, cap 3).

## Если что-то не так

- Смена/проверка моделей — сначала микропробник на реальных входах (метод:
  `docs/probe-compress-models-2026-08-26.md`), потом дефолт в `config/env.ts`.
- Застрявшие карточки сами не оживут (hourly трогает только окно TOP_N):
  свип по процедуре `docs/handoff-manual-compress-72h.md`.
- Свежесть данных на витрине: деплой = GitHub Pages из hourly; контент собирается
  из `summaries` таблицы `hn.sqlite` (VPS-бэкап `hnbackup@188.137.253.16:
  /home/hnbackup/backup/hn-distill/`) — JSON-правки без апдейта мета-БД на сайте невидимы.

## Утренний автоматический чек (Hermes → OMP)

Слои 1–3 собираются детерминированно, без LLM:

```sh
WARN_RUNS=6 SAMPLE=10 HN_DB_PATH=/tmp/hn.sqlite \
  bun run tsx scripts/prod-health-collect.mts > /tmp/facts.json
```

Секции деградируют независимо: сломавшийся источник попадает в `errors[]`,
а не валит прогон. `HN_DB_PATH` — свежая копия VPS-бэкапа (`sudo cp
/home/hnbackup/backup/hn-distill/hn.sqlite /tmp/ && sudo chmod 644 /tmp/hn.sqlite`);
без него раздел llm_usage честно скажет «нет данных».

Интерпретирует факты утренний агент по контракту
`docs/ops/morning-agent-prompt.md`: read-only, вердикт GREEN/YELLOW/RED,
≤3 находки, JSON на stdout. Суждение — работа агента; проверки — работа скрипта.
