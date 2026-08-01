import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminRoute } from './auth/AdminRoute';
import { RootRedirect } from './auth/RootRedirect';
import Shell from './components/Shell';
import GuestShell from './components/GuestShell';
import Login from './pages/Login';
import Signup from './pages/Signup';
import RedeemInvite from './pages/RedeemInvite';
import ResetPassword from './pages/ResetPassword';
import Calendar from './pages/Calendar';
import GuestCalendar from './pages/GuestCalendar';
import Predict from './pages/Predict';
import Admin from './pages/Admin';
import AdminResult from './pages/AdminResult';
import Standings from './pages/Standings';
import Results from './pages/Results';
import Rules from './pages/Rules';

export default function App() {
  return (
    <BrowserRouter basename="/f1-predict">
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/redeem" element={<RedeemInvite />} />
          <Route path="/reset" element={<ResetPassword />} />

          <Route path="/g" element={<GuestShell />}>
            <Route index element={<Navigate to="/g/calendar" replace />} />
            <Route path="calendar" element={<GuestCalendar />} />
            <Route path="standings" element={<Standings />} />
            <Route path="results" element={<Results />} />
            <Route path="rules" element={<Rules />} />
          </Route>

          <Route element={<ProtectedRoute><Shell /></ProtectedRoute>}>
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/predict" element={<Predict />} />
            <Route path="/predict/:raceId" element={<Predict />} />
            <Route path="/standings" element={<Standings />} />
            <Route path="/results" element={<Results />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/admin" element={<AdminRoute><Admin /></AdminRoute>} />
            <Route path="/admin/result/:raceId" element={<AdminRoute><AdminResult /></AdminRoute>} />
          </Route>

          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
