import { createContext, useState, useEffect, useRef, useCallback } from 'react';
import { jwtDecode } from 'jwt-decode';
import api from '../api/axios';
import toast from 'react-hot-toast';
import SessionWarningModal from '../components/SessionWarningModal';

export const AuthContext = createContext({ user: null, loading: true, logout: () => {}, login: () => {} });

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    try {
      const cached = localStorage.getItem('rems_user_cache');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(() => !localStorage.getItem('rems_user_cache'));
  const [liveStatuses, setLiveStatuses] = useState({});
  const [idleThreshold, setIdleThreshold] = useState(15); // Default 15 mins
  const [policy, setPolicy] = useState(null);
  const [status, setStatusRaw] = useState(() => {
    return localStorage.getItem('rems_current_status') || 'offline';
  });
  // Per-user WS/action lock: Map<userId_lower, expiryTimestamp>
  // Prevents stale HTTP polls from overwriting fresh WS/action status for 12s
  const wsLockMapRef = useRef(new Map());
  const [lastActivity, setLastActivity] = useState(Date.now());
  const [showWarning, setShowWarning] = useState(false);
  const [warningTimeLeft, setWarningTimeLeft] = useState('');
  const [isWithinShift, setIsWithinShift] = useState(true);
  
  const [notifications, setNotifications] = useState([]);
  
  const wsRef = useRef(null);
  const heartbeatRef = useRef(null);
  const lastActivityRef = useRef(Date.now());
  const currentUserRef = useRef(null); // Always-current user ref for WS closures

  // Smart status setter — uses per-user wsLockMapRef to prevent HTTP poll flicker.
  // Source priority: 'action' (user click) > 'ws' (WebSocket) > 'http' (poll).
  // NOTE: 'ws' source does NOT call this function directly; the WS onmessage handler
  // updates liveStatuses and setStatusRaw directly to avoid double-writes.
  const setStatus = useCallback((newStatus, source = 'action') => {
    let myIdLower = null;
    try {
      const cachedUserStr = localStorage.getItem('rems_user_cache');
      if (cachedUserStr) {
        const cachedUser = JSON.parse(cachedUserStr);
        myIdLower = String(cachedUser.id || '').toLowerCase() || null;
      }
    } catch (e) {}

    if (myIdLower) {
      const lockExpiry = wsLockMapRef.current.get(myIdLower) || 0;
      if (source === 'http') {
        // Stale HTTP: blocked if a WS/action lock is still active for this user
        if (Date.now() < lockExpiry) return;
      } else {
        // 'action' source: refresh the per-user lock for 12 seconds
        wsLockMapRef.current.set(myIdLower, Date.now() + 12000);
        // Optimistically update liveStatuses for self immediately
        setLiveStatuses(prev => ({
          ...prev,
          [myIdLower]: { status: newStatus, source: 'action', timestamp: Date.now() },
        }));
      }
    }

    setStatusRaw(newStatus);
    localStorage.setItem('rems_current_status', newStatus);
  }, []);
  // Real-time Idle Logic: Derived from the Attendance Policy (minutes -> seconds)
  const getIdleThreshold = useCallback(() => {
    return (policy?.idle_threshold_minutes || 15) * 60;
  }, [policy]);

  const disconnectWebSocket = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const reconnectAttemptsRef = useRef(0);
  const connectWebSocket = useCallback((currentUser) => {
    if (wsRef.current || !currentUser) return;
    try {
      const ws = new WebSocket('ws://localhost:8000/ws/status/');
      
      ws.onopen = () => {
        console.log('Status WebSocket Connected');
        reconnectAttemptsRef.current = 0; // Reset on success
        const activeUser = currentUserRef.current;
        if (activeUser) {
          ws.send(JSON.stringify({ type: 'presence', user_id: activeUser.id }));
          heartbeatRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'presence', user_id: activeUser.id }));
            }
          }, 10000); // 10s — fast heartbeat, safely within 35s TTL
        }
      };

      ws.onclose = () => {
        console.log('Status WebSocket Disconnected');
        wsRef.current = null;
        if (heartbeatRef.current) {
          clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
        }
        
        // Auto-reconnect with exponential backoff (use ref to get current user)
        if (reconnectAttemptsRef.current < 5) {
            const delay = Math.pow(2, reconnectAttemptsRef.current) * 1000;
            setTimeout(() => {
                reconnectAttemptsRef.current += 1;
                const latestUser = currentUserRef.current;
                if (latestUser) connectWebSocket(latestUser);
            }, delay);
        }
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        // Debug Logging
        if (data.type !== 'presence_update') {
            console.log('[WebSocket] MSG:', data.type, data);
        }

        if (data.type === 'status_update') {
          const userIdLower = String(data.user_id || '').toLowerCase();
          
          // Set a 12-second WS lock for this user so HTTP polls cannot overwrite this
          wsLockMapRef.current.set(userIdLower, Date.now() + 12000);

          // Single authoritative write to liveStatuses (no-op if status unchanged)
          setLiveStatuses(prev => {
            if (prev[userIdLower]?.status === data.status && prev[userIdLower]?.source === 'ws') return prev;
            return {
              ...prev,
              [userIdLower]: { status: data.status, source: 'ws', timestamp: Date.now() }
            };
          });

          // If it's the current user, update personal status state directly
          // (NOT via setStatus() to avoid a second liveStatuses write)
          if (currentUserRef.current && userIdLower === String(currentUserRef.current.id).toLowerCase()) {
              setStatusRaw(data.status);
              localStorage.setItem('rems_current_status', data.status);
              window.dispatchEvent(new CustomEvent('statusChange', { detail: data.status }));
          }
        } else if (data.type === 'policy_update') {
          console.log('Policy update received - triggering global sync');
          // Re-fetch everything to reflect new shift hours or session resets
          fetchInitialStatuses(currentUser.role);
          
          // Emit a custom event so specific pages (like WorkSession) can re-fetch their local status
          window.dispatchEvent(new CustomEvent('rems_sync_required'));
          
          toast.success('System policy updated', { icon: '🔄' });
        } else if (data.type === 'notification_alert') {
          const currentUserId = String(currentUser?.id || '').toLowerCase();
          const recipientId = String(data.recipient_id || '').toLowerCase();
          
          if (recipientId === currentUserId) {
            setNotifications((prev) => {
              if (prev.some(n => n.id === data.notification_id)) return prev;
              const newNotif = {
                id: data.notification_id,
                title: data.title,
                message: data.message,
                type: data.notif_type,
                sender_name: data.sender_name,
                is_read: false,
                created_at: new Date().toISOString()
              };
              
              toast.custom((t) => (
                <div className={`${t.visible ? 'animate-enter' : 'animate-leave'} max-w-md w-full bg-slate-800 shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5 border border-slate-700`}>
                  <div className="flex-1 w-0 p-4">
                    <div className="flex items-start">
                      <div className="flex-shrink-0 pt-0.5">
                        <div className={`w-2 h-2 rounded-full ${
                          data.notif_type === 'status' ? 'bg-emerald-400' : 
                          data.notif_type === 'system' ? 'bg-rose-400' : 'bg-indigo-400'
                        }`} />
                      </div>
                      <div className="ml-3 flex-1">
                        <p className="text-sm font-medium text-slate-100">{data.title}</p>
                        <p className="mt-1 text-sm text-slate-400 whitespace-pre-line">{data.message}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex border-l border-slate-700">
                    <button 
                      onClick={() => toast.dismiss(t.id)}
                      className="w-full border border-transparent rounded-none rounded-r-lg p-4 flex items-center justify-center text-sm font-medium text-indigo-400 hover:text-indigo-300 focus:outline-none"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ), { duration: 8000, id: data.notification_id });

              return [newNotif, ...prev];
            });
          }
        }
      };

      wsRef.current = ws;
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      console.error('Failed to load global policy', err);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      const refresh = localStorage.getItem('refresh_token');
      if (refresh) {
        await api.post('/auth/logout/', { refresh });
      }
    } catch (error) {
      console.error('Logout error', error);
    } finally {
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('rems_user_cache');
      localStorage.removeItem('rems_current_status');
      setUser(null);
      setStatusRaw('offline');
      disconnectWebSocket();
      setLiveStatuses({});
      window.location.href = '/login';
    }
  }, [disconnectWebSocket]);

  const fetchInitialStatusesAbortRef = useRef(null);

  const fetchInitialStatuses = useCallback(async (role) => {
    if (fetchInitialStatusesAbortRef.current) {
      fetchInitialStatusesAbortRef.current.abort();
    }
    fetchInitialStatusesAbortRef.current = new AbortController();
    const signal = fetchInitialStatusesAbortRef.current.signal;

    if (role === 'admin' || role === 'manager') {
      try {
        const res = await api.get('/status/team/', { signal });
        const team = res.data.results || res.data;
        setLiveStatuses(prev => {
          const next = { ...prev };
          team.forEach(member => {
            const memberIdLower = (member.user_id || '').toLowerCase();
            // Per-user WS/action lock: skip HTTP if a fresh WS/action update arrived within 12s
            const lockExpiry = wsLockMapRef.current.get(memberIdLower) || 0;
            if (Date.now() >= lockExpiry) {
              next[memberIdLower] = { status: member.status, source: 'http', timestamp: Date.now() };
            }
            // else: lock is active — keep the WS/action status, discard stale HTTP
          });
          return next;
        });
      } catch (err) {
        if (err.name === 'CanceledError' || err.name === 'AbortError') return;
        console.error('Failed to prepare initial live statuses', err);
      }
    } else if (role === 'employee') {
      // For employees, seed their own status in liveStatuses from /status/me/
      try {
        const res = await api.get('/status/me/', { signal });
        const myIdLower = String(res.data.user_id || '').toLowerCase();
        if (myIdLower) {
          const lockExpiry = wsLockMapRef.current.get(myIdLower) || 0;
          if (Date.now() >= lockExpiry) {
            // No active WS/action lock — safe to seed from HTTP
            setLiveStatuses(prev => ({
              ...prev,
              [myIdLower]: { status: res.data.status, source: 'http', timestamp: Date.now() }
            }));
          }
        }
      } catch (err) {
        if (err.name === 'CanceledError' || err.name === 'AbortError') return;
        // silent — WorkSession.jsx handles its own status
      }
    }

    try {
      const policyRes = await api.get('/policy/', { signal });
      const policies = policyRes.data.results || policyRes.data;
      const activePolicy = policies.find(p => p.is_active) || policies[0];
      if (activePolicy) {
        // Resolve policy details from user if available, otherwise fallback to global active policy
        const cachedUserStr = localStorage.getItem('rems_user_cache');
        const cachedUser = cachedUserStr ? JSON.parse(cachedUserStr) : null;
        if (cachedUser && cachedUser.shift_start_time) {
          setIdleThreshold(cachedUser.idle_threshold_minutes || activePolicy.idle_threshold_minutes);
          setPolicy({
            ...activePolicy,
            shift_start_time: cachedUser.shift_start_time,
            shift_end_time: cachedUser.shift_end_time,
            idle_threshold_minutes: cachedUser.idle_threshold_minutes || activePolicy.idle_threshold_minutes,
            session_timeout_hours: cachedUser.session_timeout_hours || activePolicy.session_timeout_hours,
          });
        } else {
          setIdleThreshold(activePolicy.idle_threshold_minutes);
          setPolicy(activePolicy);
        }
      }
    } catch (err) {
      console.error('Failed to fetch idle threshold', err);
    }

    // Fetch unread notifications
    try {
      const notifRes = await api.get('/notifications/?is_read=false');
      const raw = notifRes.data.results || notifRes.data;
      const uniqueIds = new Set();
      const cleanNotifs = raw.filter(n => {
        if (!uniqueIds.has(n.id)) {
          uniqueIds.add(n.id);
          return true;
        }
        return false;
      });
      setNotifications(cleanNotifs);
    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') return;
      console.error('Failed to fetch notifications', err);
    }
  }, []);

  const checkUserStatus = useCallback(async () => {
    const token = localStorage.getItem('access_token');
    if (token) {
      try {
        const res = await api.get('/auth/me/');
        setUser(res.data);
        currentUserRef.current = res.data; // Keep ref in sync
        localStorage.setItem('rems_user_cache', JSON.stringify(res.data));
        fetchInitialStatuses(res.data.role);
        connectWebSocket(res.data);
      } catch (error) {
        logout();
      }
    } else {
        localStorage.removeItem('rems_user_cache');
        setUser(null);
        currentUserRef.current = null;
        setLoading(false);
    }
    setLoading(false);
  }, [logout, fetchInitialStatuses, connectWebSocket]);

  const login = useCallback(async (email, password, otp) => {
    try {
      const res = await api.post('/auth/login/', { email, password, otp });
      localStorage.setItem('access_token', res.data.access);
      localStorage.setItem('refresh_token', res.data.refresh);
      
      // Fetch full user details from /auth/me/ to get correct shift times
      const meRes = await api.get('/auth/me/');
      localStorage.setItem('rems_user_cache', JSON.stringify(meRes.data));
      setUser(meRes.data);
      currentUserRef.current = meRes.data; // Keep ref in sync
      
      const role = meRes.data.role;
      toast.success('Login Successful');
      fetchInitialStatuses(role);
      connectWebSocket(meRes.data);
      return role; 
    } catch (error) {
      const msg = error.response?.data?.detail || 'Invalid credentials';
      toast.error(msg);
      throw error;
    }
  }, [fetchInitialStatuses, connectWebSocket]);

  const refreshActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
    setLastActivity(Date.now());
    if (showWarning) setShowWarning(false);
  }, [showWarning]);

  // HANDLE GLOBAL STATUS TOGGLING (SILENT)
  const isTogglingIdleRef = useRef(false);
  const handleIdleDetection = useCallback(async (action) => {
    // Only proceed if not already in target state or already toggling
    if (isTogglingIdleRef.current) return;
    if (action === 'start' && status !== 'working') return;
    if (action === 'stop' && status !== 'idle') return;

    // GUARD: Prevent resuming to 'Working' if screen sharing is missing (set by WorkSession.jsx)
    if (action === 'stop' && window.rems_screen_missing) {
        console.log('[GlobalTracking] Resume blocked: Screen share required');
        return;
    }

    try {
      isTogglingIdleRef.current = true;
      const thresholdSeconds = getIdleThreshold();
      const nextStatus = action === 'start' ? 'idle' : 'working';
      
      setStatus(nextStatus);
      window.dispatchEvent(new CustomEvent('statusChange', { detail: nextStatus }));

      const payload = { action };
      if (action === 'start') {
          // Retroactively set start to (now - threshold)
          const start = new Date(Date.now() - (thresholdSeconds * 1000));
          payload.start_time = start.toISOString();
      }

      await api.post('/sessions/idle/', payload);
      
      // Don't re-fetch team statuses after idle stop — liveStatuses is already locked
      // and the 5s background poll will catch up safely
      // if (action === 'stop') fetchInitialStatuses(user.role);
    } catch (err) {
      console.error('[GlobalTracking] Idle toggle failed', err);
      // Revert status on failure if it was a manual-like toggle
      // setStatus(action === 'start' ? 'working' : 'idle'); 
    } finally {
      isTogglingIdleRef.current = false;
    }
  }, [status, fetchInitialStatuses, user, getIdleThreshold]);

  useEffect(() => {
    checkUserStatus();

    // GLOBAL ACTIVITY LISTENERS
    window.addEventListener('mousemove', refreshActivity);
    window.addEventListener('keydown', refreshActivity);
    window.addEventListener('mousedown', refreshActivity);
    window.addEventListener('scroll', refreshActivity);

    return () => {
        disconnectWebSocket();
        window.removeEventListener('mousemove', refreshActivity);
        window.removeEventListener('keydown', refreshActivity);
        window.removeEventListener('mousedown', refreshActivity);
        window.removeEventListener('scroll', refreshActivity);
    };
  }, [checkUserStatus, disconnectWebSocket, refreshActivity]);

  // Periodic HTTP polling fallback for liveStatuses (admin/manager only)
  // This catches any status changes that WebSocket events may have missed
  useEffect(() => {
    if (!user || (user.role !== 'admin' && user.role !== 'manager')) return;
    const interval = setInterval(() => fetchInitialStatuses(user.role), 5000); // 5s fast fallback
    return () => clearInterval(interval);
  }, [user, fetchInitialStatuses]);

  // Periodic check for inactivity timeout based on policy
  useEffect(() => {
    if (!user || !policy?.session_timeout_hours) return;

    const checkTimeout = () => {
      // REQUIREMENT: Working status must keep session active
      if (status === 'working') {
        setLastActivity(Date.now());
        if (showWarning) setShowWarning(false);
        return;
      }

      const timeoutMs = policy.session_timeout_hours * 60 * 60 * 1000;
      const warningMs = Math.max(0, timeoutMs - (5 * 60 * 1000)); // 5 mins before
      const idleMs = Date.now() - lastActivity;

      if (idleMs >= timeoutMs) {
        console.warn('Session timeout reached due to inactivity');
        logout();
      } else if (idleMs >= warningMs) {
        const remainingSeconds = Math.ceil((timeoutMs - idleMs) / 1000);
        const mins = Math.floor(remainingSeconds / 60);
        const secs = remainingSeconds % 60;
        setWarningTimeLeft(`${mins}m ${secs}s`);
        setShowWarning(true);
      } else {
        if (showWarning) setShowWarning(false);
      }
    };

    const interval = setInterval(checkTimeout, 5000); 
    return () => clearInterval(interval);
  }, [user, policy, logout, status, lastActivity, showWarning]);

  // Reset activity timestamp when status becomes 'working' to give employee a fresh grace period
  // NOTE: The liveStatuses mirror that was previously here has been REMOVED.
  // It was a circular dependency: status change → liveStatuses write → potential re-render loop.
  // liveStatuses is now updated ONLY by: (1) WS onmessage handler, (2) setStatus('action'),
  // (3) fetchInitialStatuses HTTP poll (when no WS lock is active).
  useEffect(() => {
    if (status === 'working') {
        lastActivityRef.current = Date.now();
        setLastActivity(Date.now());
    }
  }, [status]);

  // GLOBAL AUTO-IDLE DETECTOR (FOR EMPLOYEES)
  useEffect(() => {
    if (!user || user.role !== 'employee' || status === 'offline' || status === 'on_break') return;

    const watchIdle = () => {
        // DO NOT RUN IDLE DETECTION IF SCREEN IS MISSING (waiting for resume screen share)
        if (window.rems_screen_missing) return;

        const thresholdSeconds = getIdleThreshold();
        const inactiveMs = Date.now() - lastActivityRef.current;
        if (status === 'working' && inactiveMs > thresholdSeconds * 1000) {
            handleIdleDetection('start');
        } else if (status === 'idle' && inactiveMs < 500) { // Resume instantly on activity
            handleIdleDetection('stop');
        }
    };

    const interval = setInterval(watchIdle, 1000);
    return () => clearInterval(interval);
  }, [user, status, handleIdleDetection]);

  // Global Shift Window Watcher
  useEffect(() => {
    if (user && user.role !== 'employee') {
        setIsWithinShift(true);
        return;
    }
    if (!policy?.shift_start_time || !policy?.shift_end_time) {
        setIsWithinShift(true);
        return;
    }

    const checkShift = () => {
        const now = new Date();
        const [sH, sM] = policy.shift_start_time.split(':').map(Number);
        const [eH, eM] = policy.shift_end_time.split(':').map(Number);
        const start = new Date(now).setHours(sH, sM, 0, 0);
        let end = new Date(now).setHours(eH, eM, 0, 0);
        
        let within = false;
        if (end <= start) {
            // Overnight shift
            const endNextDay = new Date(end);
            endNextDay.setDate(endNextDay.getDate() + 1);
            
            // Check if current time is within today's start and tomorrow's end
            const withinTodayStartTomorrowEnd = now >= start && now <= endNextDay;
            
            // Also check if current time is within yesterday's start and today's end (early morning)
            const startYesterday = new Date(start);
            startYesterday.setDate(startYesterday.getDate() - 1);
            const endToday = new Date(end);
            const withinYesterdayStartTodayEnd = now >= startYesterday && now <= endToday;
            
            within = withinTodayStartTomorrowEnd || withinYesterdayStartTodayEnd;
        } else {
            within = now >= start && now <= end;
        }

        if (within !== isWithinShift) {
            setIsWithinShift(within);
        }
    };

    checkShift();
    const interval = setInterval(checkShift, 30000); // Check every 30s
    return () => clearInterval(interval);
  }, [policy, isWithinShift, user]);

  const value = {
    user,
    loading,
    liveStatuses,
    idleThreshold,
    status,
    setStatus,
    policy,
    lastActivity,
    refreshActivity,
    login,
    logout,
    notifications,
    setNotifications,
    isWithinShift,
    sendJson: (data) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(data));
      }
    },
    markAsRead: async (id) => {
      try {
        await api.post(`/notifications/${id}/mark_read/`);
        setNotifications((prev) => prev.filter((n) => n.id !== id));
        toast.dismiss(id);
      } catch (err) {
        console.error(err);
      }
    },
    markAllAsRead: async () => {
      try {
        await api.post('/notifications/mark_all_read/');
        setNotifications([]);
        toast.dismiss(); // Clear all notification toasts
      } catch (err) {
        console.error(err);
      }
    }
  };

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
      <SessionWarningModal 
        isOpen={showWarning}
        onStay={refreshActivity}
        onLogout={logout}
        timeLeft={warningTimeLeft}
      />
    </AuthContext.Provider>
  );
};
