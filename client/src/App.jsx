import { Routes, Route, Navigate } from 'react-router-dom';
import MainView from './pages/MainView';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/main" replace />} />
      <Route path="/main" element={<MainView />} />
      <Route path="/settings" element={<Navigate to="/main" replace />} />
    </Routes>
  );
}

export default App;
