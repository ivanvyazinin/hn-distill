import type { TelegramDigestItem } from "@utils/telegram";

export type TaskMessage =
  | { kind: "summarize"; id: number }
  | { kind: "telegram"; item: TelegramDigestItem };
