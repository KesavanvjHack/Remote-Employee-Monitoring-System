import { useState, useEffect, useContext, useMemo, useRef } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { PlayIcon, StopIcon, PauseIcon, CameraIcon } from '@heroicons/react/24/solid';
import { ClockIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import { AuthContext } from '../../context/AuthContext';
import useWebRTC from '../../hooks/useWebRTC';

const formatTime12h = (timeStr) => {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')} ${period}`;
};

const WorkSession = () => {
  const { policy, user, status, setStatus, sendJson } = useContext(AuthContext);
  const { startSharing, stopSharing: stopWebRTC, isSharing, stream } = useWebRTC();
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [breakType, setBreakType] = useState('lunch');
  const [breakTimeLeft, setBreakTimeLeft] = useState(0);
  const [activeTicks, setActiveTicks] = useState(0); // ticks at 0.1s for smooth live counter
  const [idleTicks, setIdleTicks] = useState(0);
  const [attendance, setAttendance] = useState(null);
  const [hasCheckedOutToday, setHasCheckedOutToday] = useState(false);
  const [showCheckoutConfirm, setShowCheckoutConfirm] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastCaptureTime, setLastCaptureTime] = useState(null);
  const syncIntervalRef = useRef(null);
  // Real-time Idle Threshold: Derived from the Attendance Policy (minutes -> seconds)
  const idleThreshold = (policy?.idle_threshold_minutes || 15) * 60;

  const containerRef = useRef(null);

  // Compute shift restriction immediately — no API needed
  const isOutsideShift = useMemo(() => {
    if (user?.role === 'admin') return false; // Admins bypass
    const [sH, sM] = (policy?.shift_start_time || '09:30').split(':').map(Number);
    const shiftStart = new Date(now);
    shiftStart.setHours(sH, sM, 0, 0);
    const [eH, eM] = (policy?.shift_end_time || '18:30').split(':').map(Number);
    let shiftEnd = new Date(now);
    shiftEnd.setHours(eH, eM, 0, 0);
    
    // OVERNIGHT SHIFT FIX: If end time is before start time, it belongs to the next day
    if (shiftEnd <= shiftStart) {
        shiftEnd.setDate(shiftEnd.getDate() + 1);
        
        // If current time is early morning (e.g. 1 AM) and shift started yesterday, adjust start and end
        if (now < shiftStart && now < shiftEnd) {
            const yesterdayStart = new Date(shiftStart);
            yesterdayStart.setDate(yesterdayStart.getDate() - 1);
            const yesterdayEnd = new Date(shiftEnd);
            yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
            if (now >= yesterdayStart && now <= yesterdayEnd) {
                // We are inside the overnight shift from yesterday!
                return false; 
            }
        }
    }
    
    return now < shiftStart || now > shiftEnd;
  }, [policy, user, now]);

  // Global Snapshot Engine handled in DashboardLayout.jsx


  // 1. Fetch initial status on mount
  useEffect(() => {
    fetchStatus();
    
    // NOTE: rems_sync_required listener removed intentionally.
    // Previously this re-fetched status on every admin policy broadcast, which:
    // 1. Called setStatus('http') which could overwrite a WS-locked status
    // 2. Caused the status to flash offline briefly during each sync event
    // Policy changes are handled by the 'policy_update' WS message in AuthContext directly.

    return () => {};
  }, []); 

  // 2. Set up intervals that depend on current status and stream
  useEffect(() => {
    // Continuous Sync (Heartbeat) every 15s for high-precision
    syncIntervalRef.current = setInterval(async () => {
      if (status === 'working' || status === 'idle' || status === 'on_break') {
         try {
           await api.post('/sessions/sync/');
         } catch (err) {
           console.error('[Sync] Heartbeat failed:', err);
         }
      }
    }, 15000);

    // Fast 0.1s tick for smooth live counter + Auto-Idle logic
    const countdownId = setInterval(() => {
      const currentTime = new Date();
      setNow(currentTime); 

      if (status === 'working' && stream) {
        setActiveTicks(prev => prev + 1);
      } else if (status === 'idle') {
        setIdleTicks(prev => prev + 1);
      }

      const storedBreak = localStorage.getItem('rems_active_break');
      if (storedBreak) {
        const { endTime } = JSON.parse(storedBreak);
        const remaining = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
        setBreakTimeLeft(remaining);
      }
    }, 100); // 0.1 second ticks

    return () => {
       clearInterval(syncIntervalRef.current);
       clearInterval(countdownId);
    };
  }, [status, stream]); 

  // Auto-activate monitoring removed here (now handled globally in DashboardLayout)
  /*
  useEffect(() => {
    if ((status === 'working' || status === 'idle') && sharerRef.current && !sharerRef.current.isSharing) {
        console.log("Auto-triggering entire screen share...");
        sharerRef.current.startSharing();
    }
  }, [status]);
  */

  // RELIABLE AUTO-CHECKOUT EFFECT
  const isCheckingOutRef = useRef(false);
  useEffect(() => {
    if (!policy?.shift_end_time || loading || isCheckingOutRef.current) return;
    if (status !== 'working' && status !== 'idle') return;

    const [sH, sM] = (policy.shift_start_time || '09:30').split(':').map(Number);
    const shiftStart = new Date(now);
    shiftStart.setHours(sH, sM, 0, 0);

    const [endH, endM] = policy.shift_end_time.split(':').map(Number);
    let shiftEnd = new Date(now);
    shiftEnd.setHours(endH, endM, 0, 0);

    if (shiftEnd <= shiftStart) {
      shiftEnd.setDate(shiftEnd.getDate() + 1);
      
      // If we are currently in the early morning part (e.g. 1 AM today) of the shift that started yesterday:
      if (now < shiftStart && now < shiftEnd) {
        shiftEnd.setDate(shiftEnd.getDate() - 1);
      }
    }

    if (now >= shiftEnd) {
      isCheckingOutRef.current = true; // Lock
      console.log("DYNAMIC TRIGGER: Auto-checking out session at", now.toLocaleTimeString());
      
      handleAction('work', 'stop').then(() => {
        toast.success("Shift ended. You have been automatically checked out.");
      }).catch((err) => {
        console.error("Auto-checkout failed:", err);
      }).finally(() => {
        isCheckingOutRef.current = false;
      });
    }
  }, [now, policy, status, loading]);

  // Auto-resume work when break time expires
  useEffect(() => {
    if (status === 'on_break' && !loading) {
      const storedBreak = localStorage.getItem('rems_active_break');
      if (storedBreak) {
        const { endTime } = JSON.parse(storedBreak);
        if (Date.now() >= endTime) {
          handleBreakStop();
        }
      }
    }
  }, [breakTimeLeft, status, loading]);

  const fetchErrorCountRef = useRef(0);
  const fetchStatus = async () => {
    try {
      const res = await api.get('/status/me/');
      fetchErrorCountRef.current = 0; // Reset on success

      const httpStatus = res.data.status;
      const att = res.data.attendance;

      // ANTI-FLASH GUARD: If HTTP says 'offline' but the attendance record shows an active
      // session (user logged in but not yet checked out), the WS presence cache may have
      // expired briefly during a page refresh. Don't downgrade to offline immediately;
      // the WS reconnect will broadcast the correct status within 1-2 seconds.
      // If the user genuinely has no active session, hasActiveSession=false and offline IS applied.
      const hasActiveSession = att && att.first_login && !att.has_completed_session;
      if (httpStatus !== 'offline' || !hasActiveSession) {
        setStatus(httpStatus, 'http');
      } else {
        console.log('[WorkSession] Anti-flash: holding status — active session detected, awaiting WS confirmation');
      }

      // Always update attendance data and counters regardless of status guard
      setAttendance(att);
      if (att) {
        setHasCheckedOutToday(!!att.has_completed_session);
        setActiveTicks((att.effective_work_seconds || 0) * 10);
        setIdleTicks((att.total_idle_seconds || 0) * 10);
      } else if (httpStatus === 'offline') {
        setActiveTicks(0);
        setIdleTicks(0);
        setHasCheckedOutToday(false);
      }
    } catch (err) {
      // Only show toast on first failure to avoid spamming
      if (fetchErrorCountRef.current === 0) {
        const msg = err.response?.data?.error || 'Failed to fetch real-time status';
        toast.error(msg, { id: 'status-fetch-error' });
      }
      fetchErrorCountRef.current += 1;
      console.error('[WorkSession] fetchStatus error:', err.response?.data || err.message);
    } finally {
      setLoading(false);
    }
  };

  // UI Continuity Sync: Adjust ticks when status flips (Handled globally now, but UI needs tick shift)
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (prevStatusRef.current === 'working' && status === 'idle') {
        // Retroactive UI shift
        const thresholdTicks = idleThreshold * 10;
        setActiveTicks(prev => Math.max(0, prev - thresholdTicks));
        setIdleTicks(prev => prev + thresholdTicks);
    }
    prevStatusRef.current = status;
  }, [status]);

  const handleIdleDetection = async (action) => {
    // Deprecated in favor of global AuthContext detection
    // But kept as a shell if needed for manual toggles
  };

  const handleAction = async (endpoint, action) => {
    const originalStatus = status;
    try {
      setLoading(true);

      if (action === 'start') {
          // Trigger WebRTC screen share first
          await startSharing();
      }

      // Optimistic UI Update for instant feedback
      const expectedNewStatus = action === 'start' ? 'working' : 'offline';
      setStatus(expectedNewStatus);
      window.dispatchEvent(new CustomEvent('statusChange', { detail: expectedNewStatus }));

      // Proceed with API call
      const response = await api.post(`/sessions/${endpoint}/`, { action });
      
      if (response.data) {
          
          if (response.data.attendance) {
              setAttendance(response.data.attendance);
              setHasCheckedOutToday(!!response.data.attendance.has_completed_session);
              setActiveTicks((response.data.attendance.effective_work_seconds || 0) * 10);
              setIdleTicks((response.data.attendance.total_idle_seconds || 0) * 10);
          } else {
              await fetchStatus();
          }
          
          if (endpoint === 'work' && action === 'stop') {
             localStorage.removeItem('rems_active_break');
             await stopWebRTC();
          }
          toast.success(`Session ${action === 'start' ? 'started' : 'ended'} successfully`);
      }
    } catch (err) {
      // Revert status on failure
      setStatus(originalStatus);
      const errorMsg = err.response?.data?.error || `Failed to ${action} session. Please try again.`;
      toast.error(errorMsg);
      console.error("Action failure:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleBreakStart = async () => {
    try {
      setLoading(true);
      
      let durationMins = 60; // lunch default
      if (breakType === 'tea') durationMins = 15;
      if (breakType === 'other') durationMins = 30;
      
      const endTime = Date.now() + (durationMins * 60 * 1000);
      localStorage.setItem('rems_active_break', JSON.stringify({ type: breakType, endTime }));
      
      // Optimistic Update
      setStatus('on_break');
      window.dispatchEvent(new CustomEvent('statusChange', { detail: 'on_break' }));
      
      const response = await api.post(`/sessions/break/`, { action: 'start' });
      if (response.data.attendance) {
          setAttendance(response.data.attendance);
          setActiveTicks((response.data.attendance.effective_work_seconds || 0) * 10);
          setIdleTicks((response.data.attendance.total_idle_seconds || 0) * 10);
      } else {
          await fetchStatus();
      }
      toast.success(`${breakType.charAt(0).toUpperCase() + breakType.slice(1)} break started`);
    } catch (err) {
      toast.error(err.response?.data?.error || `Failed to start break`);
      fetchStatus();
    } finally {
      setLoading(false);
    }
  };

  const handleBreakStop = async () => {
    try {
      setLoading(true);
      
      // Optimistic Update
      setStatus('working');
      window.dispatchEvent(new CustomEvent('statusChange', { detail: 'working' }));
      
      const response = await api.post(`/sessions/break/`, { action: 'stop' });
      localStorage.removeItem('rems_active_break');
      
      if (response.data.attendance) {
          setAttendance(response.data.attendance);
          setActiveTicks((response.data.attendance.effective_work_seconds || 0) * 10);
          setIdleTicks((response.data.attendance.total_idle_seconds || 0) * 10);
      } else {
          await fetchStatus();
      }
      toast.success('Break ended');
    } catch (err) {
      toast.error(err.response?.data?.error || `Failed to end break`);
      fetchStatus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 sm:space-y-8 mt-4 sm:mt-10">
      <div className="text-center mb-6 sm:mb-10 px-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">Remote Work Terminal</h1>
        <p className="text-sm sm:text-base text-slate-400">Log your active hours and breaks for accurate attendance calculation.</p>
        
        {policy && (
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 mt-6">
            <div className="flex flex-col items-center px-4 sm:px-6 py-2 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl">
              <span className="text-[9px] sm:text-[10px] uppercase font-bold text-indigo-400 tracking-widest">Enable Time</span>
              <span className="text-base sm:text-lg font-mono font-bold text-indigo-300">
                {new Date(`2000-01-01T${policy.shift_start_time}`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="flex flex-col items-center px-4 sm:px-6 py-2 bg-rose-500/10 border border-rose-500/20 rounded-2xl">
              <span className="text-[9px] sm:text-[10px] uppercase font-bold text-rose-400 tracking-widest">Shift End</span>
              <span className="text-base sm:text-lg font-mono font-bold text-rose-300">
                {new Date(`2000-01-01T${policy.shift_end_time}`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="bg-slate-800/50 border border-slate-700 rounded-2xl sm:rounded-3xl p-6 sm:p-10 flex flex-col items-center shadow-xl">
        <div className="mb-6 sm:mb-8 p-3 sm:p-4 rounded-full bg-slate-900/80 border border-slate-700 shadow-inner">
          <ClockIcon className="h-12 w-12 sm:h-16 sm:w-16 text-indigo-400" />
        </div>
        
        <h2 className="text-lg sm:text-xl font-semibold text-slate-200 mb-6 sm:mb-8 flex flex-col items-center gap-4 w-full">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span>Current State:</span>
            <span className={`px-3 sm:px-4 py-1.5 rounded-full text-xs sm:text-base font-bold uppercase tracking-widest
              ${status === 'working' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.2)]' : 
                status === 'on_break' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 
                status === 'idle' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' :
                'bg-slate-500/10 text-slate-400 border border-slate-500/20'}
            `}>
              {status.replace('_', ' ')}
            </span>
          </div>
          
          {(status === 'working' || activeTicks > 0) && (
            <div className="flex flex-col items-center mt-2 bg-slate-900/50 px-6 sm:px-8 py-4 rounded-2xl border border-slate-700 w-full max-w-sm">
              <span className="text-[10px] sm:text-xs text-slate-400 uppercase tracking-widest font-bold mb-1 text-center">
                {status === 'idle' ? 'Work Timer Paused' : 'Total Work Time'}
              </span>
              <span className={`text-3xl sm:text-4xl font-mono font-black tracking-tight drop-shadow-[0_0_10px_rgba(16,185,129,0.3)] ${status === 'idle' ? 'text-slate-500' : 'text-emerald-400'}`}>
                {Math.floor(Math.floor(activeTicks / 10) / 3600).toString().padStart(2, '0')}:
                {Math.floor((Math.floor(activeTicks / 10) % 3600) / 60).toString().padStart(2, '0')}:
                {(Math.floor(activeTicks / 10) % 60).toString().padStart(2, '0')}
              </span>
              {status === 'idle' && (
                <div className="mt-4 pt-4 border-t border-slate-700/50 flex flex-col items-center w-full">
                   <span className="text-[9px] sm:text-[10px] text-amber-500 font-bold uppercase tracking-widest mb-1">Current Idle Duration</span>
                   <span className="text-xl sm:text-2xl font-mono font-bold text-amber-400">
                    {Math.floor(Math.floor(idleTicks / 10) / 3600).toString().padStart(2, '0')}:
                    {Math.floor((Math.floor(idleTicks / 10) % 3600) / 60).toString().padStart(2, '0')}:
                    {(Math.floor(idleTicks / 10) % 60).toString().padStart(2, '0')}
                   </span>
                </div>
              )}
            </div>
          )}
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 w-full">
          {(status === 'offline' || status === 'online') && (
            <div className="sm:col-span-2 space-y-4">
              {/* Restriction Message */}
              {user?.role !== 'admin' && isOutsideShift && (
                <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-2xl text-amber-400 text-sm">
                  <InformationCircleIcon className="h-5 w-5 shrink-0" />
                  <p>Work is only allowed during shift hours: <span className="font-bold">{formatTime12h(policy?.shift_start_time || '09:30')}</span> – <span className="font-bold">{formatTime12h(policy?.shift_end_time || '18:30')}</span>.</p>
                </div>
              )}
              {user?.role !== 'admin' && !isOutsideShift && hasCheckedOutToday && (
                <div className="flex items-center gap-3 p-4 bg-indigo-500/10 border border-indigo-500/20 rounded-2xl text-indigo-400 text-sm">
                  <InformationCircleIcon className="h-5 w-5 shrink-0" />
                  <p>You have already completed your session for today. New sessions are restricted until tomorrow.</p>
                </div>
              )}

              <button
                onClick={() => handleAction('work', 'start')}
                disabled={loading || (user?.role !== 'admin' && (hasCheckedOutToday || isOutsideShift))}
                className="w-full flex items-center justify-center gap-3 bg-emerald-600 hover:bg-emerald-500 text-white py-4 px-6 rounded-2xl font-semibold tracking-wide shadow-[0_0_20px_rgba(16,185,129,0.3)] transition-all disabled:opacity-50 disabled:grayscale"
              >
                <PlayIcon className="h-6 w-6" />
                Start Work
              </button>
            </div>
          )}

          {(status === 'working' || status === 'idle') && (
            <>
              {/* Stream Disconnection Warning (occurs on refresh or error) */}
              {!stream && (
                <div className="sm:col-span-2 p-6 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex flex-col items-center gap-4 animate-pulse">
                  <div className="flex items-center gap-3 text-rose-400">
                    <CameraIcon className="h-6 w-6" />
                    <span className="font-bold">Screen sharing required</span>
                  </div>
                  <p className="text-sm text-slate-400 text-center">
                    You are currently in a {status} session, but screen sharing is not active. 
                    Please share your entire screen to continue working.
                  </p>
                  <button
                    onClick={startSharing}
                    className="w-full flex items-center justify-center gap-3 bg-rose-600 hover:bg-rose-500 text-white py-3 px-6 rounded-xl font-bold transition-all shadow-lg"
                  >
                    <PlayIcon className="h-5 w-5" />
                    {isSharing ? 'Resume Screen Sharing' : 'Start Screen Sharing'}
                  </button>
                </div>
              )}

              {(status === 'working' || status === 'idle') && stream && (
                <div className="flex flex-col gap-3">
                  <select 
                    value={breakType}
                    onChange={(e) => setBreakType(e.target.value)}
                    disabled={loading || (user?.role !== 'admin' && isOutsideShift)}
                    className="w-full bg-slate-900/80 border border-slate-700 rounded-2xl px-4 py-3 text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 uppercase tracking-widest text-sm font-semibold disabled:opacity-50"
                  >
                    <option value="lunch">Lunch Break (60m)</option>
                    <option value="tea">Tea Break (15m)</option>
                    <option value="other">Other Break (30m)</option>
                  </select>
                  <button
                    onClick={handleBreakStart}
                    disabled={loading || (user?.role !== 'admin' && isOutsideShift)}
                    className="flex items-center justify-center gap-3 bg-cyan-600 hover:bg-cyan-500 text-white py-4 px-6 rounded-2xl font-semibold tracking-wide shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all disabled:opacity-50"
                  >
                    <PauseIcon className="h-6 w-6" />
                    Start Break
                  </button>
                </div>
              )}
              {/* Custom Checkout Confirmation Modal */}
              {showCheckoutConfirm ? (
                <div className="sm:col-span-2 p-6 bg-slate-900/90 border border-rose-500/50 rounded-2xl flex flex-col items-center gap-4 shadow-[0_0_30px_rgba(225,29,72,0.2)] animate-in fade-in zoom-in duration-200">
                  <h3 className="text-xl font-bold text-white">End Today's Session?</h3>
                  <p className="text-sm text-slate-400 text-center max-w-sm">
                    Are you sure you want to check out for today? You will <strong className="text-rose-400">not be able to log back in</strong> or start a new session until tomorrow.
                  </p>
                  <div className="flex gap-4 w-full mt-2">
                    <button
                      onClick={() => setShowCheckoutConfirm(false)}
                      disabled={loading}
                      className="flex-1 py-3 px-4 rounded-xl font-bold bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                    >
                      No, Keep Working
                    </button>
                    <button
                      onClick={() => {
                        setShowCheckoutConfirm(false);
                        handleAction('work', 'stop');
                      }}
                      disabled={loading}
                      className="flex-1 py-3 px-4 rounded-xl font-bold bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-500/30 transition-colors"
                    >
                      Yes, Check Out
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowCheckoutConfirm(true)}
                  disabled={loading || (user?.role !== 'admin' && isOutsideShift)}
                  className="flex items-center justify-center gap-3 bg-rose-600 hover:bg-rose-500 text-white py-4 px-6 rounded-2xl font-semibold tracking-wide shadow-[0_0_20px_rgba(225,29,72,0.3)] transition-all disabled:opacity-50 sm:col-span-2"
                >
                  <StopIcon className="h-6 w-6" />
                  End Work / Check Out
                </button>
              )}
            </>
          )}

          {status === 'on_break' && (
            <div className="sm:col-span-2 flex flex-col items-center gap-4 sm:gap-6 bg-slate-900/50 p-6 sm:p-8 rounded-2xl sm:rounded-3xl border border-cyan-500/20 shadow-inner">
              <div className="text-center">
                <p className="text-cyan-400 text-[10px] sm:text-sm font-bold uppercase tracking-widest mb-2">Time Remaining</p>
                <div className="text-4xl sm:text-5xl font-mono font-black text-white drop-shadow-[0_0_15px_rgba(6,182,212,0.5)] tracking-tighter">
                  {Math.floor(breakTimeLeft / 60).toString().padStart(2, '0')}:{(breakTimeLeft % 60).toString().padStart(2, '0')}
                </div>
              </div>
              <button
                onClick={handleBreakStop}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 bg-emerald-600 hover:bg-emerald-500 text-white py-3.5 sm:py-4 px-6 rounded-2xl font-bold tracking-wide shadow-[0_0_25px_rgba(16,185,129,0.4)] transition-all disabled:opacity-50"
              >
                <PlayIcon className="h-6 w-6" />
                End Break & Resume Work
              </button>
            </div>
          )}
        </div>
      </div>


    </div>
  );
};

export default WorkSession;
