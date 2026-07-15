import { describe, expect, test } from "bun:test";

import {
  COMMENTS_DEDUP_THRESHOLD,
  containment,
  dedupByContainment,
} from "../utils/comments-dedup.ts";

describe("comments dedup containment", () => {
  test("fixes threshold at 0.7", () => {
    expect(COMMENTS_DEDUP_THRESHOLD).toBe(0.7);
  });

  test("catches real demo near-duplicates (VPN/SSH, Wireguard/Headscale, correlation≠causation)", () => {
    // Calibrated on comments v2 demo cards (Tailscale 48915004, sleep 48919363).
    expect(
      containment(
        "VPN через SSH удобнее, чем отдельный корпоративный VPN-клиент, для доступа к внутренним сервисам.",
        "Для доступа к внутренним сервисам люди предпочитают VPN через SSH вместо отдельного корпоративного VPN."
      )
    ).toBeGreaterThanOrEqual(0.7);

    // Without stop-word filtering this pair sits below the threshold (~0.67 with full tokens).
    expect(
      containment(
        "Self-hosted Wireguard через Headscale проще для небольшой команды, чем полный Tailscale.",
        "Для небольшой команды self-hosted Wireguard с Headscale проще полного Tailscale."
      )
    ).toBeGreaterThanOrEqual(0.7);

    // Same semantic claim restated with light reordering — stem+stop-words must still fire.
    expect(
      containment(
        "Корреляция не означает причинность: сон и здоровье связаны, направление связи неясно из данных.",
        "Корреляция не означает причинность: здоровье и сон связаны, из данных направление связи неясно."
      )
    ).toBeGreaterThanOrEqual(0.7);
  });

  test("does not treat unrelated insights as duplicates", () => {
    expect(
      containment(
        "VPN через SSH удобнее для доступа к внутренним сервисам, чем отдельный клиент.",
        "Корреляция сна и здоровья не доказывает причинность без эксперимента."
      )
    ).toBeLessThan(0.7);
  });

  test("normalizes NFKC, case, and punctuation before comparing", () => {
    const a = "WireGuard setup is simpler for small teams!";
    const b = "wireguard setup is simpler for small teams.";
    expect(containment(a, b)).toBe(1);
  });

  test("EN near-duplicate pair is caught", () => {
    expect(
      containment(
        "Use feature flags for gradual rollout before full production cutover.",
        "Prefer feature flags for a gradual rollout ahead of the full production cutover."
      )
    ).toBeGreaterThanOrEqual(0.7);
  });
});

describe("dedupByContainment", () => {
  test("drops insights that restate the bottom line", () => {
    const bottom =
      "Тред добавляет практический опыт: VPN через SSH проще корпоративного клиента для доступа к сервисам.";
    const texts = [
      "VPN через SSH удобнее корпоративного VPN-клиента для доступа к внутренним сервисам.",
      "Self-hosted Wireguard через Headscale проще для небольшой команды.",
    ];
    expect(dedupByContainment(bottom, texts)).toEqual([1]);
  });

  test("keeps the earlier ranked insight when a later one is a near-duplicate", () => {
    const texts = [
      "Self-hosted Wireguard через Headscale проще для небольшой команды, чем полный Tailscale.",
      "Для небольшой команды self-hosted Wireguard с Headscale проще полного Tailscale.",
      "Корреляция сна и здоровья не доказывает причинность без экспериментальных данных.",
    ];
    expect(dedupByContainment("Главный вывод треда про инфраструктуру доступа.", texts)).toEqual([0, 2]);
  });

  test("preserves original order of survivors", () => {
    const texts = [
      "Первый уникальный тезис про эксплуатацию очередей в проде с реальными цифрами.",
      "Второй уникальный тезис про отказоустойчивость кэша при пиковых нагрузках.",
      "Третий уникальный тезис про стоимость миграции без даунтайма для клиентов.",
    ];
    expect(dedupByContainment("Общий вывод без пересечения с тезисами ниже.", texts)).toEqual([0, 1, 2]);
  });
});
