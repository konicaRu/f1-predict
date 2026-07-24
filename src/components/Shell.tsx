import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const tabs = [
  { to: '/calendar', label: 'Календарь' },
  { to: '/predict', label: 'Прогноз' },
  { to: '/standings', label: 'Зачёт' },
  { to: '/results', label: 'Результаты' },
  { to: '/rules', label: 'Правила' },
];

export default function Shell() {
  const { isAdmin, signOut } = useAuth();
  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-left">
          <span className="hdr-label">PRIVATE LEAGUE</span>
          <span className="hdr-title">F1 Predict</span>
          <span className="hdr-sub">Лига прогнозов · сезон 2026</span>
        </div>
        <button className="hdr-logout" onClick={() => signOut()}>Выход</button>
      </header>
      <nav className="nav">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => 'nav-tab' + (isActive ? ' active' : '')}>
            {t.label}
          </NavLink>
        ))}
        {isAdmin && (
          <NavLink to="/admin" className={({ isActive }) => 'nav-tab' + (isActive ? ' active' : '')}>
            Админ
          </NavLink>
        )}
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
