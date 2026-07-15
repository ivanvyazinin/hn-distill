import type { CommentsInsights } from "../../config/schemas.ts";

const RU_BOTTOM =
  "Тред добавляет практический опыт: VPN через SSH проще корпоративного клиента для доступа к внутренним сервисам.";
const RU_ADVICE =
  "Проверяйте предложенный подход на небольшом воспроизводимом примере перед полным запуском.";
const RU_CONSENSUS =
  "Участники согласны, что измерения нужно повторить на реальной нагрузке перед выбором архитектуры.";
const RU_DISPUTE =
  "Спор: одна сторона за постепенный rollout с feature flags, другая — за полный cutover после тестов.";

const EN_BOTTOM =
  "The thread adds operational experience: SSH-based VPN is simpler than a corporate client for internal access.";
const EN_ADVICE =
  "Test the proposed approach on a small reproducible example before a full production rollout.";
const EN_CONSENSUS =
  "Commenters agree that benchmarks must be repeated under realistic production load before choosing architecture.";
const EN_DISPUTE =
  "Debate: one side prefers gradual rollout with feature flags, the other prefers a full cutover after tests.";

export function makeRuCommentsInsights(overrides: Partial<CommentsInsights> = {}): CommentsInsights {
  return {
    bottom_line: RU_BOTTOM,
    insights: [
      { kind: "advice", text: RU_ADVICE },
      { kind: "consensus", text: RU_CONSENSUS },
    ],
    best_quote: null,
    ...overrides,
  };
}

export function makeEnCommentsInsights(overrides: Partial<CommentsInsights> = {}): CommentsInsights {
  return {
    bottom_line: EN_BOTTOM,
    insights: [
      { kind: "advice", text: EN_ADVICE },
      { kind: "consensus", text: EN_CONSENSUS },
    ],
    best_quote: null,
    ...overrides,
  };
}

export function makeRuDisputeInsight(text: string = RU_DISPUTE): CommentsInsights["insights"][number] {
  return { kind: "dispute", text };
}

export function makeEnDisputeInsight(text: string = EN_DISPUTE): CommentsInsights["insights"][number] {
  return { kind: "dispute", text };
}

export const COMMENTS_INSIGHTS_FIXTURE_TEXT = {
  ru: {
    bottom: RU_BOTTOM,
    advice: RU_ADVICE,
    consensus: RU_CONSENSUS,
    dispute: RU_DISPUTE,
  },
  en: {
    bottom: EN_BOTTOM,
    advice: EN_ADVICE,
    consensus: EN_CONSENSUS,
    dispute: EN_DISPUTE,
  },
} as const;
