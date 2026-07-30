-- 0018_guest_access_fix2.sql — доп. закрытие того же класса проблемы, что 0017: anon по
-- умолчанию имел табличные INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER на users (сейчас
-- неэксплуатируемо — нет anon-политик на запись users — но лишние права отзываем на будущее,
-- по образцу отзыва SELECT в 0017).
revoke insert, update, delete, truncate, references, trigger on public.users from anon;
