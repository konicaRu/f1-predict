// src/lib/telegram.ts
export function getTelegramDeepLinkRaceId(): number | null {
  const tg = (window as any).Telegram?.WebApp;
  const startParam: string | undefined = tg?.initDataUnsafe?.start_param;
  const match = startParam?.match(/^predict_(\d+)$/);
  return match ? Number(match[1]) : null;
}
