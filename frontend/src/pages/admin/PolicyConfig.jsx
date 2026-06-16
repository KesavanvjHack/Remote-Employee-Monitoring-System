import { useState, useEffect } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { AdjustmentsHorizontalIcon, CheckIcon } from '@heroicons/react/24/outline';

const CustomTimePicker = ({ value, onChange }) => {
  const [hourStr, minStr] = (value || '09:00').split(':');
  const h24 = parseInt(hourStr, 10) || 0;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;

  const handleHour = (e) => {
    let newH = parseInt(e.target.value, 10);
    if (ampm === 'PM' && newH < 12) newH += 12;
    if (ampm === 'AM' && newH === 12) newH = 0;
    onChange(`${newH.toString().padStart(2, '0')}:${minStr}`);
  };

  const handleMin = (e) => {
    onChange(`${hourStr.padStart(2, '0')}:${e.target.value.padStart(2, '0')}`);
  };

  const handleAmPm = (e) => {
    const newAmPm = e.target.value;
    if (newAmPm === ampm) return;
    let newH = h24;
    if (newAmPm === 'PM') newH += 12;
    if (newAmPm === 'AM') newH -= 12;
    onChange(`${newH.toString().padStart(2, '0')}:${minStr}`);
  };

  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const mins = ['00', '15', '30', '45'];

  return (
    <div className="flex items-center gap-2">
      <label className="sr-only">Hour</label>
      <select 
        value={h12} 
        onChange={handleHour} 
        className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50"
      >
        {hours.map(h => <option key={h} value={h}>{h.toString().padStart(2, '0')}</option>)}
      </select>
      <span className="text-slate-400 font-bold">:</span>
      <label className="sr-only">Minute</label>
      <select 
        value={minStr} 
        onChange={handleMin} 
        className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50"
      >
        {mins.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
      <label className="sr-only">AM/PM</label>
      <select 
        value={ampm} 
        onChange={handleAmPm} 
        className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 font-bold"
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
};

const PolicyConfig = () => {
  const [policy, setPolicy] = useState(null);
  const [allPolicies, setAllPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetDate, setResetDate] = useState(new Date().toISOString().split('T')[0]);
  const [resetting, setResetting] = useState(false);

  // New states for expanded reset tools
  const [scope, setScope] = useState('all');
  const [employeeId, setEmployeeId] = useState('');
  const [rangeType, setRangeType] = useState('today');
  const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [employees, setEmployees] = useState([]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [policyRes, employeesRes] = await Promise.all([
        api.get('/policy/'),
        api.get('/users/?role=employee&is_active=true')
      ]);

      const policyData = policyRes.data.results ? policyRes.data.results : policyRes.data;
      setAllPolicies(policyData || []);

      // Look for Morning Shift first, then Night Shift, then whatever is first
      let activePolicy = policyData.find(p => p.name === 'Morning Shift') || 
                         policyData.find(p => p.name === 'Night Shift') || 
                         policyData[0];
      if (activePolicy) {
        setPolicy(activePolicy);
      } else {
        // Fallback policy if none exists
        setPolicy({
          name: 'Morning Shift',
          min_working_hours: 8.0,
          present_hours: 8.0,
          half_day_hours: 4.0,
          idle_threshold_minutes: 15,
          shift_start_time: '09:30:00',
          shift_end_time: '17:30:00',
          session_timeout_hours: 24,
          base_hourly_rate: 20.00,
          overtime_rate_multiplier: 1.50,
          night_differential_multiplier: 1.20
        });
      }

      const employeeData = employeesRes.data.results || employeesRes.data;
      setEmployees(employeeData || []);
    } catch (error) {
      toast.error('Failed to load configuration data');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      let res;
      if (policy.id) {
        res = await api.put(`/policy/${policy.id}/`, policy);
      } else {
        res = await api.post(`/policy/`, policy);
      }
      toast.success('Attendance Policy updated successfully');
      const updatedPolicy = res.data;
      setAllPolicies(prev => {
        const index = prev.findIndex(p => p.name === updatedPolicy.name);
        if (index !== -1) {
          return prev.map(p => p.name === updatedPolicy.name ? updatedPolicy : p);
        } else {
          return [...prev, updatedPolicy];
        }
      });
      setPolicy(updatedPolicy);
    } catch (error) {
      toast.error('Failed to update policy');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (scope === 'particular' && !employeeId) {
      toast.error('Please select an employee');
      return;
    }

    const employeeText = scope === 'all' 
      ? 'ALL employees' 
      : `employee ${employees.find(e => e.id === employeeId)?.full_name || employeeId}`;
    
    let timeframeText = '';
    if (rangeType === 'today') {
      timeframeText = `today (${resetDate})`;
    } else if (rangeType === 'week') {
      timeframeText = 'this week';
    } else if (rangeType === 'custom') {
      timeframeText = `from ${startDate} to ${endDate}`;
    }

    if (!window.confirm(`Are you sure you want to RESET attendance sessions for ${employeeText} for ${timeframeText}? This will permanently delete all work sessions, breaks, and idle logs. This action cannot be undone.`)) {
      return;
    }
    
    setResetting(true);
    try {
      const payload = {
        scope,
        range_type: rangeType,
      };
      if (scope === 'particular') {
        payload.employee_id = employeeId;
      }
      if (rangeType === 'today') {
        payload.date = resetDate;
      } else if (rangeType === 'custom') {
        payload.start_date = startDate;
        payload.end_date = endDate;
      }

      const res = await api.post('/policy/reset_day_sessions/', payload);
      toast.success(res.data.message || 'Attendance sessions reset successfully');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to reset sessions');
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl space-y-6 page-fade-in">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-slate-700 rounded-lg w-10 h-10 skeleton-pulse"></div>
          <div className="h-8 w-64 bg-slate-700 rounded skeleton-pulse"></div>
        </div>
        <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8 h-96 skeleton-pulse"></div>
      </div>
    );
  }
  if (!policy) return <div className="text-rose-400 page-fade-in">No Policy Available</div>;

  return (
    <div className="max-w-3xl space-y-6 page-fade-in">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-indigo-500/20 rounded-lg">
          <AdjustmentsHorizontalIcon className="h-6 w-6 text-indigo-400" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Global Attendance Policy</h1>
      </div>

      <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8 shadow-xl">
        <form onSubmit={handleSave} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <label htmlFor="policyName" className="block text-sm font-medium text-slate-300 mb-2">Choose Shift (M/N)</label>
              <select
                id="policyName"
                name="policy-name"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all outline-none"
                value={policy.name}
                onChange={(e) => {
                  const newName = e.target.value;
                  const matched = allPolicies.find(p => p.name === newName);
                  if (matched) {
                    setPolicy(matched);
                  } else {
                    // Create local placeholder before save
                    setPolicy({
                      name: newName,
                      min_working_hours: 8.0,
                      present_hours: 8.0,
                      half_day_hours: 4.0,
                      idle_threshold_minutes: 15,
                      shift_start_time: newName === 'Night Shift' ? '19:30:00' : '09:30:00',
                      shift_end_time: newName === 'Night Shift' ? '03:30:00' : '17:30:00',
                      session_timeout_hours: 24,
                      base_hourly_rate: 20.00,
                      overtime_rate_multiplier: 1.50,
                      night_differential_multiplier: 1.20
                    });
                  }
                }}
              >
                <option value="Morning Shift">Morning Shift</option>
                <option value="Night Shift">Night Shift</option>
              </select>
            </div>
            
            <div>
              <label htmlFor="idleThreshold" className="block text-sm font-medium text-slate-300 mb-2">Idle Threshold (Minutes)</label>
              <input
                type="number"
                id="idleThreshold"
                name="idle-threshold"
                required
                min="1"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                value={policy.idle_threshold_minutes}
                onChange={(e) => setPolicy({ ...policy, idle_threshold_minutes: parseInt(e.target.value) })}
                title="Minutes of mouse/keyboard inactivity before state switches to Idle"
              />
              <p className="mt-2 text-xs text-slate-500">Auto-triggers Idle state after {policy.idle_threshold_minutes} min of inactivity.</p>
            </div>

            <div>
              <label htmlFor="minWorkHours" className="block text-sm font-medium text-slate-300 mb-2">Minimum Full-Day Hours</label>
              <input
                type="number"
                id="minWorkHours"
                name="min-work-hours"
                required
                step="0.5"
                min="0"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                value={policy.min_working_hours}
                onChange={(e) => setPolicy({ ...policy, min_working_hours: parseFloat(e.target.value) })}
              />
            </div>

            <div>
              <label htmlFor="presentHours" className="block text-sm font-medium text-slate-300 mb-2">Present Hours</label>
              <input
                type="number"
                id="presentHours"
                name="present-hours"
                required
                step="0.5"
                min="0"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                value={policy.present_hours}
                onChange={(e) => setPolicy({ ...policy, present_hours: parseFloat(e.target.value) })}
                title="Minimum hours to mark attendance as Present"
              />
            </div>

            <div>
              <label htmlFor="halfDayHours" className="block text-sm font-medium text-slate-300 mb-2">Minimum Half-Day Hours</label>
              <input
                type="number"
                id="halfDayHours"
                name="half-day-hours"
                required
                step="0.5"
                min="0"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                value={policy.half_day_hours}
                onChange={(e) => setPolicy({ ...policy, half_day_hours: parseFloat(e.target.value) })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Attendance Starting Time</label>
              <CustomTimePicker 
                value={policy.shift_start_time || '09:30'} 
                onChange={(val) => setPolicy({...policy, shift_start_time: val})}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">Auto-Calculating Last Time</label>
              <CustomTimePicker 
                value={policy.shift_end_time || '17:30'} 
                onChange={(val) => setPolicy({...policy, shift_end_time: val})}
              />
            </div>

            <div>
              <label htmlFor="sessionTimeout" className="block text-sm font-medium text-slate-300 mb-2">Session Timeout (Hours)</label>
              <input
                type="number"
                id="sessionTimeout"
                name="session-timeout"
                required
                step="0.5"
                min="0.5"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                value={policy.session_timeout_hours || 24}
                onChange={(e) => setPolicy({ ...policy, session_timeout_hours: parseFloat(e.target.value) })}
                title="Absolute maximum hours a login session can last before auto-logout"
              />
              <p className="mt-2 text-xs text-slate-500">Users will be automatically logged out after {policy.session_timeout_hours || 24} hours of continuous session.</p>
            </div>

            <div>
              <label htmlFor="baseHourlyRate" className="block text-sm font-medium text-slate-300 mb-2">Base Hourly Rate ($)</label>
              <input
                type="number"
                id="baseHourlyRate"
                name="base-hourly-rate"
                required
                step="0.01"
                min="0"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                value={policy.base_hourly_rate !== undefined ? policy.base_hourly_rate : 20.00}
                onChange={(e) => setPolicy({ ...policy, base_hourly_rate: parseFloat(e.target.value) })}
                title="Standard base hourly rate used for payroll calculations"
              />
            </div>

            <div>
              <label htmlFor="overtimeMultiplier" className="block text-sm font-medium text-slate-300 mb-2">Overtime Rate Multiplier (e.g., 1.5x)</label>
              <input
                type="number"
                id="overtimeMultiplier"
                name="overtime-multiplier"
                required
                step="0.01"
                min="1.0"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                value={policy.overtime_rate_multiplier !== undefined ? policy.overtime_rate_multiplier : 1.50}
                onChange={(e) => setPolicy({ ...policy, overtime_rate_multiplier: parseFloat(e.target.value) })}
                title="Multiplier applied to standard base hourly rate for hours exceeding standard daily limit"
              />
            </div>

            <div>
              <label htmlFor="nightMultiplier" className="block text-sm font-medium text-slate-300 mb-2">Night Differential Multiplier (e.g., 1.2x)</label>
              <input
                type="number"
                id="nightMultiplier"
                name="night-multiplier"
                required
                step="0.01"
                min="1.0"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                value={policy.night_differential_multiplier !== undefined ? policy.night_differential_multiplier : 1.20}
                onChange={(e) => setPolicy({ ...policy, night_differential_multiplier: parseFloat(e.target.value) })}
                title="Multiplier applied to base rate for night shift differential hours"
              />
            </div>
          </div>

          <div className="pt-6 border-t border-slate-700/50 flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg font-medium shadow-[0_0_15px_rgba(99,102,241,0.3)] transition-all disabled:opacity-50"
            >
              <CheckIcon className="h-5 w-5" />
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </form>
      </div>

      {/* Administrative Controls */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8 border-t-4 border-t-rose-500/50 shadow-xl mt-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-rose-500/20 rounded-lg">
            <svg className="h-6 w-6 text-rose-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-white tracking-tight">Administrative Tools</h2>
        </div>
        
        <p className="text-slate-400 text-sm mb-6 max-w-xl leading-relaxed">
          <span className="text-rose-400 font-bold uppercase text-[10px] tracking-widest block mb-1">Danger Zone</span>
          Resetting attendance will permanently delete all work sessions, breaks, and idle logs for the selected users and timeframe. This action is irreversible and should only be used for data correction.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <div>
            <label htmlFor="resetScope" className="block text-sm font-medium text-slate-300 mb-2">Target Employees</label>
            <select
              id="resetScope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500/50 transition-all outline-none"
            >
              <option value="all">All Employees</option>
              <option value="particular">Particular Employee</option>
            </select>
          </div>

          {scope === 'particular' && (
            <div>
              <label htmlFor="resetEmployee" className="block text-sm font-medium text-slate-300 mb-2">Select Employee</label>
              <select
                id="resetEmployee"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500/50 transition-all outline-none"
              >
                <option value="">-- Choose Employee --</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.full_name} ({emp.email})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor="resetRange" className="block text-sm font-medium text-slate-300 mb-2">Timeframe</label>
            <select
              id="resetRange"
              value={rangeType}
              onChange={(e) => setRangeType(e.target.value)}
              className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500/50 transition-all outline-none"
            >
              <option value="today">Today / Specific Date</option>
              <option value="week">This Week</option>
              <option value="custom">Custom Date Range</option>
            </select>
          </div>

          {rangeType === 'today' && (
            <div>
              <label htmlFor="resetDate" className="block text-sm font-medium text-slate-300 mb-2">Target Date</label>
              <input
                type="date"
                id="resetDate"
                name="reset-date"
                className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500/50 transition-all outline-none"
                value={resetDate}
                onChange={(e) => setResetDate(e.target.value)}
              />
            </div>
          )}

          {rangeType === 'custom' && (
            <div className="grid grid-cols-2 gap-4 col-span-1 md:col-span-2">
              <div>
                <label htmlFor="startDate" className="block text-sm font-medium text-slate-300 mb-2">Start Date</label>
                <input
                  type="date"
                  id="startDate"
                  className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500/50 transition-all outline-none"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="endDate" className="block text-sm font-medium text-slate-300 mb-2">End Date</label>
                <input
                  type="date"
                  id="endDate"
                  className="w-full bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-2.5 text-slate-200 focus:ring-2 focus:ring-rose-500/50 focus:border-rose-500/50 transition-all outline-none"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={handleReset}
            disabled={resetting}
            className="w-full sm:w-auto h-[46px] flex items-center justify-center gap-2 bg-rose-600 hover:bg-rose-500 text-white px-8 rounded-lg font-semibold shadow-[0_0_20px_rgba(244,63,94,0.25)] hover:shadow-[0_0_25px_rgba(244,63,94,0.4)] transition-all disabled:opacity-50 disabled:cursor-not-allowed transform hover:-translate-y-0.5 active:translate-y-0"
          >
            {resetting ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Resetting...
              </span>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Reset Sessions
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PolicyConfig;
