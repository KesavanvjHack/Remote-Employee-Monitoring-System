import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * LiveDuration - A flicker-free real-time duration ticker.
 *
 * Key anti-flicker strategies:
 * 1. Only accept server syncs that move the timer FORWARD or represent a
 *    significant jump backward (> 2s), which indicates a real state change.
 *    Small backward jitter from 1s HTTP polling is ignored.
 * 2. Normalize all status strings so "On Break", "on_break", and "on break"
 *    are all treated identically.
 * 3. Use a ref to track the latest status without causing effect re-runs,
 *    preventing the ticker interval from being torn down and recreated on
 *    every status update.
 */
const normalizeStatus = (raw) => {
  if (!raw) return 'offline';
  const s = raw.toLowerCase().replace(/[\s_]+/g, '_');
  // Map all variants to a canonical form
  if (s === 'working') return 'working';
  if (s === 'on_break') return 'on_break';
  if (s === 'idle') return 'idle';
  if (s === 'online') return 'online';
  return 'offline';
};

const LiveDuration = ({ initialSeconds, status, type, isToday, isWithinShift = false, className = '' }) => {
  const [ticks, setTicks] = useState(() => Math.floor((initialSeconds || 0) * 10));
  const statusRef = useRef(normalizeStatus(status));
  const typeRef = useRef(type);
  const shiftRef = useRef(isWithinShift);

  useEffect(() => {
    shiftRef.current = isWithinShift;
  }, [isWithinShift]);

  // Keep refs up-to-date without re-running the ticker effect
  useEffect(() => {
    statusRef.current = normalizeStatus(status);
  }, [status]);

  useEffect(() => {
    typeRef.current = type;
  }, [type]);

  // Sync with server value – reject small jumps that cause flicker
  useEffect(() => {
    const serverTicks = Math.floor((initialSeconds || 0) * 10);
    setTicks(prev => {
      if (prev === 0 && serverTicks > 0) return serverTicks;
      
      if (typeRef.current === 'gap') {
        // Gap counts DOWN. Fresh data is a SMALLER value.
        if (serverTicks <= prev) return serverTicks;
        // Significant upward jump = real state change (e.g. shift updated)
        if (serverTicks - prev > 600) return serverTicks;
        return prev;
      } else {
        // Normal duration counts UP. Fresh data is a LARGER value.
        if (serverTicks >= prev) return serverTicks;
        // Significant downward jump = real state change
        if (prev - serverTicks > 600) return serverTicks;
        return prev;
      }
    });
  }, [initialSeconds]);

  const shouldTick = useCallback(() => {
    const s = statusRef.current;
    const t = typeRef.current;
    if (t === 'work' && s === 'working') return true;
    if (t === 'break' && s === 'on_break') return true;
    if (t === 'idle' && s === 'idle') return true;
    if (t === 'gap' && (s === 'working' || s === 'on_break' || s === 'idle')) return true; // Gap DECREASES when clocked in
    return false;
  }, []);

  // Single stable ticker interval – only recreated when isToday changes
  useEffect(() => {
    if (!isToday) return;

    const interval = setInterval(() => {
      if (shouldTick()) {
        setTicks(prev => {
           if (typeRef.current === 'gap') {
             return Math.max(0, prev - 1);
           }
           return prev + 1;
        });
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isToday, shouldTick]);

  const totalS = typeRef.current === 'gap' ? Math.ceil(ticks / 10) : Math.floor(ticks / 10);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = Math.floor(totalS % 60);
  const format2 = (num) => num.toString().padStart(2, '0');

  return (
    <span className={`inline-flex items-baseline ${className}`}>
      {format2(h)}:{format2(m)}:{format2(s)}
    </span>
  );
};

export default React.memo(LiveDuration);
