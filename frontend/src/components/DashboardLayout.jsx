import { useContext, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { AuthContext } from '../context/AuthContext';
import useWebRTC from '../hooks/useWebRTC';
import api from '../api/axios';

const DashboardLayout = ({ children }) => {
  const { user } = useContext(AuthContext);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const location = useLocation();
  
  // Track navigation progress for speed perception
  const [navProgress, setNavProgress] = useState(0);

  useEffect(() => {
    if (user && location.pathname !== '/' && !location.pathname.includes('/login')) {
      localStorage.setItem('rems_last_active_page', location.pathname);
      
      // Simulate fast progress bar on nav
      setNavProgress(30);
      const t1 = setTimeout(() => setNavProgress(70), 100);
      const t2 = setTimeout(() => {
        setNavProgress(100);
        setTimeout(() => setNavProgress(0), 200);
      }, 300);
      
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    }
  }, [location.pathname, user]);

  // SYNC: Automatic Idle during Screen Disconnection (Global)
  const { stream } = useWebRTC();
  const { status, setStatus } = useContext(AuthContext);

  useEffect(() => {
    if (!user || user.role === 'admin' || status === 'offline' || status === 'on_break') return;

    // If working/idle but screen sharing is NOT active (e.g. after refresh)
    // We force the backend to 'Idle' state to pause work hour calculation
    if ((status === 'working' || status === 'idle') && !stream && !window.rems_screen_missing) {
        window.rems_screen_missing = true;
        setStatus('idle');
        window.dispatchEvent(new CustomEvent('statusChange', { detail: 'idle' }));
        api.post('/sessions/idle/', { 
            action: 'start',
            reason: 'screen_disconnected' 
        }).catch(() => {});
    } 
    // Resume work automatically ONLY IF stream is captured AND we were explicitly idle due to missing stream
    else if (status === 'idle' && stream && window.rems_screen_missing) {
        window.rems_screen_missing = false;
        setStatus('working');
        window.dispatchEvent(new CustomEvent('statusChange', { detail: 'working' }));
        api.post('/sessions/idle/', { action: 'stop' }).catch(() => {});
    }

  }, [status, stream, user, setStatus]);

  return (
    <div className="flex bg-slate-900 h-screen overflow-hidden selection:bg-indigo-500/30">
      {/* Performance Progress Bar */}
      {navProgress > 0 && (
        <div id="rems-progress" style={{ width: `${navProgress}%` }} />
      )}

      <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      
      {/* Mobile Backdrop */}
      {isSidebarOpen && (
        <div 
          className="lg:hidden fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-40 transition-opacity duration-300"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      <div className="flex-1 lg:ml-64 flex flex-col h-screen max-w-full overflow-hidden">
        <TopBar onMenuClick={() => setIsSidebarOpen(true)} />
        <main 
          key={location.pathname} 
          className="flex-1 p-4 sm:p-8 overflow-y-auto relative animate-page-enter"
        >
          {children || <Outlet />}
        </main>
      </div>
    </div>
  );
};

export default DashboardLayout;
