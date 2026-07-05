import { useState, useEffect, useContext, useRef, useCallback } from 'react';
import api from '../../api/axios';
import ResponsiveTable from '../../components/ResponsiveTable';
import { ChartBarIcon, ClockIcon, BuildingOfficeIcon, UserGroupIcon, ExclamationTriangleIcon, FlagIcon, ArrowDownTrayIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import toast from 'react-hot-toast';
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, parseISO, format } from 'date-fns';
import { formatLastLogout, formatDecimalHours } from '../../utils/format';
import LiveDuration from '../../components/LiveDuration';
import { AuthContext } from '../../context/AuthContext';
import ShiftTable from '../../components/admin/ShiftTable';

const parseTime12hToMinutes = (time12h) => {
  if (!time12h) return 0;
  const match = time12h.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return 0;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours < 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
};

const format24hTo12h = (time24h) => {
  if (!time24h) return '09:30 AM';
  const [h, m] = time24h.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return `${hour12.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')} ${period}`;
};

const AttendanceHub = () => {
  const [attendance, setAttendance] = useState([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const { policy, user, liveStatuses } = useContext(AuthContext);

  // Filter states
  const today = new Date().toISOString().split('T')[0];
  const [dateFilter, setDateFilter] = useState('today');
  const [roleFilter, setRoleFilter] = useState('all');
  const [employeeFilter, setEmployeeFilter] = useState('all');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [shiftFilter, setShiftFilter] = useState('all');

  useEffect(() => {
    fetchData();

    // Auto-refresh every 15 seconds for attendance data (login times, durations)
    // Status is driven by WS via AuthContext.liveStatuses, so no need for fast polling here
    const intervalId = setInterval(() => {
      fetchData(true); // silent refresh
    }, 15000);

    // Instant refresh on attendance-level changes only (not status-only WS updates)
    const handleRefresh = () => fetchData(true);
    window.addEventListener('rems_sync_required', handleRefresh);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('rems_sync_required', handleRefresh);
    };
  }, [dateFilter, startDate, endDate]);

  const abortControllerRef = useRef(null);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      let params = {};
      if (dateFilter === 'today') {
        params.date = today;
      } else if (dateFilter === 'this_week') {
        const now = new Date();
        params.date__gte = startOfWeek(now, { weekStartsOn: 1 }).toISOString().split('T')[0];
        params.date__lte = endOfWeek(now, { weekStartsOn: 1 }).toISOString().split('T')[0];
      } else if (dateFilter === 'this_month') {
        const now = new Date();
        params.date__gte = startOfMonth(now).toISOString().split('T')[0];
        params.date__lte = endOfMonth(now).toISOString().split('T')[0];
      } else if (dateFilter === 'custom' && startDate && endDate) {
        params.date__gte = startDate;
        params.date__lte = endDate;
      }

      const [attRes, sumRes, usersRes] = await Promise.all([
        api.get('/attendance/', { params, signal: abortControllerRef.current.signal }),
        api.get('/reports/?type=summary', { params: dateFilter === 'today' ? { from_date: today, to_date: today } : {}, signal: abortControllerRef.current.signal }),
        api.get('/users/', { signal: abortControllerRef.current.signal })
      ]);
      const allAtt = attRes.data.results || attRes.data;
      const allUsers = usersRes.data.results || usersRes.data;
      
      setLastUpdated(new Date());

      const todayStr = new Date().toISOString().split('T')[0];
      const usersWithRecordToday = new Set(allAtt.filter(a => a.date === todayStr).map(a => a.user));
      
      const missingUsers = allUsers.filter(u => 
        u.is_active !== false && !usersWithRecordToday.has(u.id)
      );
      
      const targetSeconds = (policy?.min_working_hours || 8) * 3600;

      const dummyRecords = missingUsers.map(u => ({
        id: `dummy_${u.id}_${todayStr}`,
        user: u.id,
        user_name: u.full_name || 'N/A',
        user_email: u.email,
        user_role: u.role,
        shift_name: u.shift_name || 'Morning Shift',
        manager_name: u.manager_name || '—',
        date: todayStr,
        status: 'Absent',
        live_status: 'Offline',
        first_login: null,
        last_logout: '--:--',
        total_work_seconds: 0,
        total_break_seconds: 0,
        total_idle_seconds: 0,
        missing_seconds: targetSeconds,
        is_flagged: false,
        flag_reason: '',
        manager_remark: 'No record found / Absent',
        shift_start: format24hTo12h(u.shift_start_time),
        shift_end: format24hTo12h(u.shift_end_time),
      }));
      
      setAttendance([...allAtt, ...dummyRecords]);
      setSummary(sumRes.data);
    } catch (error) {
      if (error.name === 'CanceledError' || error.name === 'AbortError') return;
      if (!silent) {
         toast.error('Failed to load attendance data');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [dateFilter, startDate, endDate, today]);

  // Local calculateDuration removed as we now use shared formatDuration utility

  const getFilteredRecords = () => {
    let records = attendance.filter(record => (record.user_role || 'employee').toLowerCase() !== 'admin');
    
    if (roleFilter !== 'all') {
      records = records.filter(record => (record.user_role || 'employee').toLowerCase() === roleFilter);
    }

    if (employeeFilter !== 'all') {
      records = records.filter(record => record.user_name === employeeFilter);
    }

    if (shiftFilter !== 'all') {
      records = records.filter(record => (record.shift_name || '').toLowerCase().includes(shiftFilter));
    }
    
    // Since we now filter on the server, we just need to return the records
    // Note: Missing users are only generated for 'today'
    return records.sort((a, b) => new Date(b.date) - new Date(a.date));
  };

  const handleExport = () => {
    const records = getFilteredRecords();
    if (records.length === 0) {
      toast.error('No records found to export');
      return;
    }

    const headers = ['Date', 'Name', 'Role', 'Login Time', 'Last Logout', 'Daily Attendance', 'Work (h)', 'Break (h)', 'Idle (h)', 'Gap (h)', 'Anomalies', 'Remarks / Reason'];
    const csvData = records.map(record => [
      record.date,
      record.user_name,
      record.user_role || 'Employee',
      formatLastLogout(record.first_login),
      formatLastLogout(record.last_logout),
      record.status,
      formatDecimalHours(record.total_work_seconds),
      formatDecimalHours(record.total_break_seconds),
      formatDecimalHours(record.total_idle_seconds),
      formatDecimalHours(record.missing_seconds),
      record.is_flagged ? `Yes - ${record.flag_reason}` : 'No',
      record.manager_remark || record.flag_reason || '-'
    ]);

    const csvContent = [
      headers.join(','),
      ...csvData.map(row => row.map(r => {
        const val = r === undefined || r === null ? '' : String(r);
        return `"${val.replace(/"/g, '""')}"`;
      }).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `attendance_export_${dateFilter}_${Date.now()}.csv`;
    link.click();
    toast.success('Attendance exported successfully');
  };

  const handleOverride = async (record, status) => {
    try {
      if (!window.confirm(`Are you sure you want to change ${record.user_name}'s status to ${status.toUpperCase()}?`)) return;
      
      await api.post('/attendance/override_status/', {
        user_id: record.user,
        date: record.date,
        status: status,
        remark: 'Overridden by Admin via Hub'
      });
      toast.success('Status updated successfully');
      fetchData(true);
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to update status');
    }
  };

  const filteredRecords = getFilteredRecords();
  const morningRecords = filteredRecords.filter(r => (r.shift_name || '').toLowerCase().includes('morning'));
  const nightRecords = filteredRecords.filter(r => (r.shift_name || '').toLowerCase().includes('night'));
  const otherRecords = filteredRecords.filter(r => 
    !(r.shift_name || '').toLowerCase().includes('morning') && 
    !(r.shift_name || '').toLowerCase().includes('night')
  );

  if (loading) return <div className="text-indigo-400 p-8 text-center animate-pulse">Loading Attendance Hub...</div>;

  return (
    <div className="space-y-6 page-fade-in">
      <div className="flex flex-col gap-6 mb-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">Attendance Hub</h1>
          <button
            onClick={handleExport}
            className="inline-flex lg:hidden items-center justify-center rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400 gap-2 transition-colors"
          >
            <ArrowDownTrayIcon className="h-4 w-4" />
            <span>Export</span>
          </button>
        </div>
        
        <div className="flex flex-wrap items-center gap-3 w-full">
          {roleFilter === 'all' && (
            <div className="flex-1 min-w-[150px]">
              <select
                id="employeeFilter"
                name="employee-filter"
                value={employeeFilter}
                onChange={(e) => setEmployeeFilter(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 p-2.5"
              >
                <option value="all">All Personnel</option>
                {Array.from(new Set(attendance.filter(r => r.user_role !== 'admin').map(r => r.user_name))).sort().map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex-1 min-w-[120px]">
            <select
              id="roleFilter"
              name="role-filter"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 p-2.5"
            >
              <option value="all">All Roles</option>
              <option value="manager">Managers</option>
              <option value="employee">Employees</option>
            </select>
          </div>

          <div className="flex-1 min-w-[120px]">
            <select
              id="shiftFilter"
              name="shift-filter"
              value={shiftFilter}
              onChange={(e) => setShiftFilter(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 p-2.5"
            >
              <option value="all">All Shifts</option>
              <option value="morning">Morning Shift</option>
              <option value="night">Night Shift</option>
            </select>
          </div>

          <div className="flex-1 min-w-[120px]">
            <select
              id="dateFilter"
              name="date-filter"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 p-2.5"
            >
              <option value="today">Today</option>
              <option value="this_week">This Week</option>
              <option value="this_month">This Month</option>
              <option value="custom">Custom Dates</option>
            </select>
          </div>

          {dateFilter === 'custom' && (
            <div className="flex items-center gap-2 w-full md:w-auto">
              <input
                type="date"
                id="startDate"
                name="start-date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="flex-1 bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg p-2.5"
              />
              <span className="text-slate-500">to</span>
              <input
                type="date"
                id="endDate"
                name="end-date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="flex-1 bg-slate-900 border border-slate-700 text-slate-300 text-sm rounded-lg p-2.5"
              />
            </div>
          )}

          <button
            onClick={handleExport}
            className="hidden lg:inline-flex items-center justify-center rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-400 gap-2 transition-colors ml-auto"
          >
            <ArrowDownTrayIcon className="h-5 w-5" />
            Export CSV
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <div className="bg-slate-800/50 p-4 sm:p-6 rounded-xl border border-slate-700">
          <div className="flex items-center gap-3 text-emerald-400 mb-2">
            <UserGroupIcon className="h-5 w-5 sm:h-6 sm:w-6" />
            <h3 className="text-sm sm:font-semibold">Present</h3>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-white">{getFilteredRecords().filter(r => r.status?.toLowerCase() === 'present').length}</p>
        </div>
        <div className="bg-slate-800/50 p-4 sm:p-6 rounded-xl border border-slate-700">
          <div className="flex items-center gap-3 text-sky-400 mb-2">
            <ClockIcon className="h-5 w-5 sm:h-6 sm:w-6" />
            <h3 className="text-sm sm:font-semibold">Half Day</h3>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-white">{getFilteredRecords().filter(r => r.status?.toLowerCase() === 'half_day' || r.status?.toLowerCase() === 'half day').length}</p>
        </div>
        <div className="bg-slate-800/50 p-4 sm:p-6 rounded-xl border border-slate-700">
          <div className="flex items-center gap-3 text-rose-400 mb-2">
            <ExclamationTriangleIcon className="h-5 w-5 sm:h-6 sm:w-6" />
            <h3 className="text-sm sm:font-semibold">Absent</h3>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-white">
            {getFilteredRecords().filter(r => {
              const status = (r.status || '').toLowerCase();
              if (status !== 'absent') return false;
              
              const now = new Date();
              const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
              const istDate = new Date(istString);

              const [recYear, recMonth, recDay] = r.date.split('-').map(Number);
              const shiftEndDate = new Date(recYear, recMonth - 1, recDay);
              const startMin = parseTime12hToMinutes(r.shift_start || '09:30 AM');
              const endMin = parseTime12hToMinutes(r.shift_end || '05:30 PM');
              shiftEndDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
              if (endMin <= startMin) {
                shiftEndDate.setDate(shiftEndDate.getDate() + 1);
              }

              const isToday = r.date === today;
              const isBeforeShiftEnd = istDate < shiftEndDate;
              return !(isToday && isBeforeShiftEnd);
            }).length}
          </p>
        </div>
        <div className="bg-slate-800/50 p-4 sm:p-6 rounded-xl border border-slate-700">
          <div className="flex items-center gap-3 text-fuchsia-400 mb-2">
            <BuildingOfficeIcon className="h-5 w-5 sm:h-6 sm:w-6" />
            <h3 className="text-sm sm:font-semibold">On Leave</h3>
          </div>
          <p className="text-2xl sm:text-3xl font-bold text-white">{getFilteredRecords().filter(r => r.status?.toLowerCase() === 'on_leave' || r.status?.toLowerCase() === 'on leave').length}</p>
        </div>
        {dateFilter === 'today' && (
          <div className="bg-slate-800/50 p-4 sm:p-6 rounded-xl border border-slate-700">
            <div className="flex items-center gap-3 text-blue-400 mb-2">
              <ClockIcon className="h-5 w-5 sm:h-6 sm:w-6" />
              <h3 className="text-sm sm:font-semibold">Calculating</h3>
            </div>
            <p className="text-2xl sm:text-3xl font-bold text-white">
              {getFilteredRecords().filter(r => {
                const now = new Date();
                const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
                const istDate = new Date(istString);

                const [recYear, recMonth, recDay] = r.date.split('-').map(Number);
                const shiftEndDate = new Date(recYear, recMonth - 1, recDay);
                const startMin = parseTime12hToMinutes(r.shift_start || '09:30 AM');
                const endMin = parseTime12hToMinutes(r.shift_end || '05:30 PM');
                shiftEndDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
                if (endMin <= startMin) {
                  shiftEndDate.setDate(shiftEndDate.getDate() + 1);
                }

                const shiftStartDate = new Date(recYear, recMonth - 1, recDay);
                shiftStartDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
                const isBeforeShiftStart = istDate < shiftStartDate;
                const isNotStarted = isBeforeShiftStart && !r.first_login;

                const isToday = r.date === today;
                const isBeforeShiftEnd = istDate < shiftEndDate;
                
                const status = (r.status || '').toLowerCase();
                return isToday && isBeforeShiftEnd && !isNotStarted && status !== 'present' && status !== 'on_leave' && status !== 'holiday' && status !== 'halfday' && status !== 'half_day';
              }).length}
            </p>
          </div>
        )}
      </div>

      {/* Tables split by shift */}
      <div className="space-y-8">
        <ShiftTable title="Morning Shift Attendance" records={morningRecords} lastUpdated={lastUpdated} fetchData={fetchData} loading={loading} dateFilter={dateFilter} startDate={startDate} endDate={endDate} handleOverride={handleOverride} liveStatuses={liveStatuses} user={user} />
        <ShiftTable title="Night Shift Attendance" records={nightRecords} lastUpdated={lastUpdated} fetchData={fetchData} loading={loading} dateFilter={dateFilter} startDate={startDate} endDate={endDate} handleOverride={handleOverride} liveStatuses={liveStatuses} user={user} />
        {otherRecords.length > 0 && <ShiftTable title="Other Shift Attendance" records={otherRecords} lastUpdated={lastUpdated} fetchData={fetchData} loading={loading} dateFilter={dateFilter} startDate={startDate} endDate={endDate} handleOverride={handleOverride} liveStatuses={liveStatuses} user={user} />}
      </div>
    </div>
  );
};

export default AttendanceHub;
