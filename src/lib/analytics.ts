// Google Analytics 4. Сам скрипт и идентификатор потока — в index.html (там же отсечка по хосту:
// на localhost внешний скрипт не грузится, а gtag() остаётся безопасной заглушкой). Здесь — только
// обёртки, которые никогда не бросают: блокировщик рекламы или сбой сети не должны ломать сайт.
//
// Что уходит в Google: путь страницы, названия событий и pseudonymous user_id (UUID аккаунта Supabase).
// Имена, email и прогнозы в аналитику НЕ отправляются (правила Google запрещают персональные данные).
type Gtag = (...args: unknown[]) => void;

function gtag(): Gtag | null {
  const f = (window as unknown as { gtag?: unknown }).gtag;
  return typeof f === 'function' ? (f as Gtag) : null;
}

// Адрес страницы БЕЗ query и fragment. На /reset Supabase кладёт в fragment токены восстановления
// пароля (#access_token=…&refresh_token=…) — отдавать их третьей стороне нельзя. gtag по умолчанию
// берёт полный location.href (параметр dl), поэтому адрес задаём явно и на каждое событие.
function cleanLocation(): string {
  return window.location.origin + window.location.pathname;
}

export function trackPageView(path: string): void {
  try {
    const g = gtag();
    if (!g) return;
    g('set', { page_location: cleanLocation() });
    g('event', 'page_view', {
      page_path: path,
      page_location: cleanLocation(),
      page_title: document.title,
    });
  } catch {
    // аналитика необязательна
  }
}

export function trackEvent(name: string, params?: Record<string, string | number | boolean>): void {
  try {
    const g = gtag();
    if (!g) return;
    g('set', { page_location: cleanLocation() });
    g('event', name, params);
  } catch {
    // аналитика необязательна
  }
}

// Привязка к аккаунту: UUID (не имя и не email). null — вышел/не вошёл.
export function setAnalyticsUser(userId: string | null): void {
  try {
    const g = gtag();
    if (!g) return;
    g('set', { user_id: userId ?? undefined });
    // Отдельным измерением — откуда открыт сайт: из Telegram (кнопка/ссылка в чате) или из браузера.
    g('set', 'user_properties', {
      in_telegram: Boolean((window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData),
    });
  } catch {
    // аналитика необязательна
  }
}
