// supabase/functions/telegram-auth/index.ts
import { withSupabase } from 'npm:@supabase/server';
import { verifyInitData } from './verify.ts';

function syntheticEmail(telegramId: number): string {
  return `tg${telegramId}@telegram.f1predict.local`;
}

export default {
  fetch: withSupabase({ auth: 'publishable' }, async (req, ctx) => {
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      return Response.json({ error: 'TELEGRAM_BOT_TOKEN не настроен' }, { status: 500 });
    }

    let initData: string;
    try {
      const body = await req.json();
      initData = body.initData;
      if (typeof initData !== 'string' || !initData) throw new Error('empty');
    } catch {
      return Response.json({ error: 'initData обязателен' }, { status: 400 });
    }

    try {
      const verified = await verifyInitData(initData, botToken);
      if (!verified.ok) {
        return Response.json({ error: `initData невалиден: ${verified.reason}` }, { status: 401 });
      }

      const { supabaseAdmin, supabase } = ctx;
      const email = syntheticEmail(verified.user.id);

      // supabaseAdmin has no Database generic (project has no generated Supabase types anywhere,
      // same as the rest of the codebase) — .from<>()'s TableName/Table params are derived from
      // the CLIENT's own Schema generic (fixed to `never` here), not injectable per-call, so an
      // inline row-shape generic doesn't type-check. Falling back to `as any`, consistent with
      // the rest of this file.
      const linkTable = supabaseAdmin.from('telegram_links') as any;

      // Идентичность резолвится через telegram_links СНАЧАЛА, а не через "generateLink нашёл email".
      // Telegram user id — публичное число (видно всем в общем чате). Синтетический email из него
      // детерминирован, а обычная форма регистрации (Signup.tsx) не ограничена по домену — значит
      // до того как настоящий владелец Telegram-аккаунта впервые откроет Mini App, кто угодно может
      // заранее зарегистрировать tg<id>@telegram.f1predict.local с паролем под своим контролем.
      // Если бы мы доверяли "generateLink нашёл email" как сигналу "это наш аккаунт", атакующий
      // молча получал бы сессию в СВОЙ преждевременно созданный аккаунт вместо отказа.
      const { data: link, error: linkLookupError } = await linkTable
        .select('user_id')
        .eq('telegram_user_id', verified.user.id)
        .maybeSingle();
      if (linkLookupError) {
        return Response.json({ error: `telegram_links lookup: ${linkLookupError.message}` }, { status: 500 });
      }

      let magicLink;
      if (link) {
        // Уже привязан ранее (эта функция сама создала этот email через createUser ниже) — просто минтим сессию.
        magicLink = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
        if (magicLink.error) {
          return Response.json({ error: `не удалось выпустить сессию: ${magicLink.error.message}` }, { status: 500 });
        }
      } else {
        // Ещё не привязан — создаём НОВЫЙ аккаунт. Если email уже занят (сквоттинг синтетического email через
        // обычную форму регистрации ДО того, как реальный Telegram-пользователь впервые открыл Mini App) —
        // это конфликт, не совпадение: отказываем, а не молча выдаём сессию в чужой аккаунт.
        const created = await supabaseAdmin.auth.admin.createUser({
          email,
          email_confirm: true,
          user_metadata: {
            telegram_id: verified.user.id,
            telegram_first_name: verified.user.first_name,
            telegram_username: verified.user.username ?? null,
          },
        });
        if (created.error || !created.data.user) {
          // Возможна гонка: параллельный запрос того же нового Telegram-пользователя (двойной тап)
          // мог между нашим SELECT выше и этим createUser уже создать аккаунт и записать telegram_links.
          // Перепроверяем один раз — если линк появился, это гонка, а не конфликт с чужим аккаунтом.
          const { data: raceLink, error: raceLinkError } = await linkTable
            .select('user_id')
            .eq('telegram_user_id', verified.user.id)
            .maybeSingle();
          if (raceLinkError) {
            return Response.json({ error: `telegram_links lookup: ${raceLinkError.message}` }, { status: 500 });
          }
          if (!raceLink) {
            return Response.json(
              { error: `email уже занят или не удалось создать аккаунт: ${created.error?.message}` },
              { status: 409 },
            );
          }
          magicLink = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
          if (magicLink.error) {
            return Response.json({ error: `не удалось выпустить сессию: ${magicLink.error.message}` }, { status: 500 });
          }
        } else {
          magicLink = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
          if (magicLink.error) {
            return Response.json({ error: `не удалось выпустить сессию: ${magicLink.error.message}` }, { status: 500 });
          }
        }
      }

      const hashedToken = magicLink.data.properties?.hashed_token;
      if (!hashedToken) {
        return Response.json({ error: 'magic link без hashed_token' }, { status: 500 });
      }

      const verifiedOtp = await supabase.auth.verifyOtp({ token_hash: hashedToken, type: 'email' });
      if (verifiedOtp.error || !verifiedOtp.data.session) {
        return Response.json({ error: `verifyOtp: ${verifiedOtp.error?.message}` }, { status: 500 });
      }

      const userId = verifiedOtp.data.session.user.id;
      const { error: upsertError } = await linkTable.upsert(
        { telegram_user_id: verified.user.id, user_id: userId },
        { onConflict: 'telegram_user_id' },
      );
      if (upsertError) console.error('telegram_links upsert failed:', upsertError.message);

      return Response.json({
        access_token: verifiedOtp.data.session.access_token,
        refresh_token: verifiedOtp.data.session.refresh_token,
      });
    } catch (e) {
      return Response.json(
        { error: `неожиданная ошибка: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }
  }),
};
