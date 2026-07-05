import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import Shell from './components/Shell';
import Login from './pages/Login';
import Signup from './pages/Signup';
import RedeemInvite from './pages/RedeemInvite';
import Calendar from './pages/Calendar';
import Predict from './pages/Predict';

const Stub = ({ name }: { name: string }) => (
  <div className="stub">Экран «{name}» — в следующих под-проектах</div>
);

export default function App() {
  return (
    <BrowserRouter basename="/f1-predict">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/redeem" element={<RedeemInvite />} />
          <Route element={<ProtectedRoute><Shell /></ProtectedRoute>}>
            <Route index element={<Navigate to="/calendar" replace />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/predict" element={<Predict />} />
            <Route path="/predict/:raceId" element={<Predict />} />
            <Route path="/standings" element={<Stub name="Зачёт" />} />
            <Route path="/results" element={<Stub name="Результаты" />} />
            <Route path="/admin" element={<Stub name="Админка" />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
