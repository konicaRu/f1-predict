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

    const verified = await verifyInitData(initData, botToken);
    if (!verified.ok) {
      return Response.json({ error: `initData невалиден: ${verified.reason}` }, { status: 401 });
    }

    const { supabaseAdmin, supabase } = ctx;
    const email = syntheticEmail(verified.user.id);

    let magicLink = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
    if (magicLink.error) {
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
        return Response.json({ error: `не удалось создать аккаунт: ${created.error?.message}` }, { status: 500 });
      }
      magicLink = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
      if (magicLink.error) {
        return Response.json({ error: `не удалось выпустить сессию: ${magicLink.error.message}` }, { status: 500 });
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
    // supabaseAdmin has no Database generic (project has no generated Supabase types anywhere,
    // same as the rest of the codebase) — .from() can't infer telegram_links' row shape without it.
    await (supabaseAdmin.from('telegram_links') as any).upsert(
      { telegram_user_id: verified.user.id, user_id: userId },
      { onConflict: 'telegram_user_id' },
    );

    return Response.json({
      access_token: verifiedOtp.data.session.access_token,
      refresh_token: verifiedOtp.data.session.refresh_token,
    });
  }),
};
