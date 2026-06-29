-- 0002_scoring.sql — формула очков (plan §3, D5). Дубль TS-версии scoring.ts.

create or replace function public.score_prediction(prediction jsonb, actual jsonb)
returns table (points int, exact_hits int)
language plpgsql immutable as $$
declare
  weights int[] := array[25,18,15,12,10,8,6,4,2,1];
  y int; i int; x int; p int;
  code text;
begin
  points := 0;
  exact_hits := 0;
  for y in 1..10 loop
    code := prediction->>(y-1);                 -- пилот в слоте Y
    if code is null then continue; end if;
    x := null;                                  -- реальная позиция (1-based)
    for i in 0..(jsonb_array_length(actual)-1) loop
      if actual->>i = code then x := i+1; exit; end if;
    end loop;
    if x is null then continue; end if;         -- вне реального топ-10
    p := greatest(0, weights[y] - 2*abs(x - y));
    if x = y then
      p := p + 3;
      exact_hits := exact_hits + 1;
    end if;
    points := points + p;
  end loop;
  return next;
end;
$$;

-- View очков: считается из predictions ⋈ results. security_invoker → уважает RLS
-- (до дедлайна чужие прогнозы не утекают и через view).
create view public.scores
  with (security_invoker = true) as
select p.user_id, p.race_id, s.points, s.exact_hits
from public.predictions p
join public.results r on r.race_id = p.race_id
cross join lateral public.score_prediction(p.positions, r.positions) s;
