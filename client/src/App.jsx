import { Routes, Route, Navigate } from 'react-router-dom';
import MainView from './pages/MainView';
import SettingsView from './pages/SettingsView';

function App() {
  // 設定が保存済みならメイン画面へ直行、未設定なら設定画面へ
  const hasConfig = !!localStorage.getItem('sfu_config');
  return (
    <Routes>
      <Route path="/" element={<Navigate to={hasConfig ? '/main' : '/settings'} replace />} />
      <Route path="/main" element={<MainView />} />
      <Route path="/settings" element={<SettingsView />} />
    </Routes>
  );
}

export default App;
