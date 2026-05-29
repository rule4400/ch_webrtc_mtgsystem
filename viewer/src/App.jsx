import { Routes, Route, Navigate } from 'react-router-dom';
import ViewerView from './pages/ViewerView';
import SettingsView from './pages/SettingsView';

function App() {
  const hasConfig = !!localStorage.getItem('sfu_viewer_config');
  return (
    <Routes>
      <Route path="/" element={<Navigate to={hasConfig ? '/viewer' : '/settings'} replace />} />
      <Route path="/viewer" element={<ViewerView />} />
      <Route path="/settings" element={<SettingsView />} />
    </Routes>
  );
}

export default App;
