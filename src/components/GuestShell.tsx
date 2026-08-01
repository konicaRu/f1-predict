import { NavLink, Link, Outlet } from 'react-router-dom';

const tabs = [
  { to: '/g/calendar', label: 'Календарь' },
  { to: '/g/standings', label: 'Зачёт' },
  { to: '/g/results', label: 'Результаты' },
  { to: '/g/rules', label: 'Правила' },
];

export default function GuestShell() {
  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-left">
          <span className="hdr-label">ГОСТЕВОЙ ПРОСМОТР</span>
          <span className="hdr-title">F1 Predict</span>
          <span className="hdr-sub">Лига прогнозов · сезон 2026</span>
        </div>
        <Link className="hdr-logout" to="/login">Войти</Link>
      </header>
      <nav className="nav">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => 'nav-tab' + (isActive ? ' active' : '')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
