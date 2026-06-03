import { Routes, Route, Navigate } from 'react-router-dom';
import ViewerView from './pages/ViewerView';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/viewer" replace />} />
      <Route path="/viewer" element={<ViewerView />} />
      <Route path="/settings" element={<Navigate to="/viewer" replace />} />
    </Routes>
  );
}

export default App;
