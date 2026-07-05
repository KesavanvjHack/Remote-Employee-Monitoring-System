import React from 'react';
import ResponsiveTable from '../ResponsiveTable';
import { ClockIcon, ArrowPathIcon, FlagIcon } from '@heroicons/react/24/outline';
import { format, parseISO } from 'date-fns';
import LiveDuration from '../LiveDuration';
import usePagination from '../../hooks/usePagination';
import PaginationControls from '../PaginationControls';

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

// Memoized row component to prevent the entire table from re-rendering
// when a single user's live status changes in the websocket dictionary.
const ShiftTableRow = React.memo(({ record, user, wsStatus, handleOverride, todayStr }) => {
  const now = new Date();
  const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const istDate = new Date(istString);
  
  const [recYear, recMonth, recDay] = record.date.split('-').map(Number);
  const shiftStartDate = new Date(recYear, recMonth - 1, recDay);
  const startMin = parseTime12hToMinutes(record.shift_start || '09:30 AM');
  shiftStartDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);

  const shiftEndDate = new Date(recYear, recMonth - 1, recDay);
  const endMin = parseTime12hToMinutes(record.shift_end || '05:30 PM');
  shiftEndDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
  if (endMin <= startMin) {
    shiftEndDate.setDate(shiftEndDate.getDate() + 1);
  }

  const isBeforeShiftStart = istDate < shiftStartDate;
  const isBeforeShiftEnd = istDate < shiftEndDate;

  const isToday = record.date === todayStr;
  const yesterday = new Date(istDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  const isRecordActive = isToday || (record.date === yesterdayStr && endMin <= startMin);

  const isCalculating = isRecordActive && 
                      isBeforeShiftEnd &&
                      record.status?.toLowerCase() !== 'present' && 
                      record.status?.toLowerCase() !== 'on_leave' && 
                      record.status?.toLowerCase() !== 'holiday' &&
                      record.status?.toLowerCase() !== 'half_day';
  
  let displayStatus = record.status;
  let isNotStartedState = false;
  if (isCalculating) {
    if (isBeforeShiftStart && !record.first_login) {
      displayStatus = 'Not Started';
      isNotStartedState = true;
    } else {
      displayStatus = 'Calculating...';
    }
  }

  const mapStatusToLiveLabel = (status) => {
    if (!status) return 'Offline';
    const s = status.toLowerCase();
    if (s === 'working') return 'Working';
    if (s === 'on_break' || s === 'on break') return 'On Break';
    if (s === 'idle') return 'Idle';
    if (s === 'online') return 'Online';
    return 'Offline';
  };

  const resolvedStatusStr = wsStatus ? (typeof wsStatus === 'object' ? wsStatus.status : wsStatus) : null;
  const resolvedLiveStatus = resolvedStatusStr ? mapStatusToLiveLabel(resolvedStatusStr) : (record.live_status || 'Offline');
  
  const normalizedStatus = record.status?.toLowerCase();

  return (
    <tr className="hover:bg-slate-700/30 transition-colors">
      <td className="px-2 py-3">
        <div className="flex flex-col items-center sm:items-start text-center sm:text-left">
          <span className="text-xs font-semibold text-white">{record.user_name}</span>
          <span className="text-[10px] text-slate-400 truncate max-w-[120px]">{record.user_email}</span>
        </div>
      </td>
      <td className="px-2 py-3 text-center text-xs text-slate-300 font-semibold">
        {record.manager_name || '—'}
      </td>
      <td className="px-2 py-3 text-center font-mono leading-tight whitespace-nowrap">
        <span className={`block text-xs font-bold ${isCalculating ? 'text-rose-400' : 'text-indigo-400'}`}>
          {record.first_login ? format(parseISO(record.first_login), 'hh:mm a') : '--:--'}
        </span>
        <span className="block text-slate-600 text-[10px] my-0.5">to</span>
        <span className="block text-rose-400 text-xs font-bold">
          {record.last_logout && record.last_logout !== '--:--' ? format(parseISO(record.last_logout), 'hh:mm a') : '--:--'}
        </span>
      </td>
      <td className="px-2 py-3 text-center">
        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-widest flex items-center justify-center gap-1 w-max mx-auto
          ${isCalculating ? (isNotStartedState ? 'bg-slate-500/10 text-slate-400 border border-slate-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20') :
            normalizedStatus === 'present' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 
            normalizedStatus === 'absent' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' :
            normalizedStatus === 'half_day' || normalizedStatus === 'half day' ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20' :
            normalizedStatus === 'on_leave' || normalizedStatus === 'on leave' ? 'bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/20' :
            'bg-slate-500/10 text-slate-400 border border-slate-500/20'}
        `}>
          {displayStatus === 'on_leave' ? 'On Leave' : displayStatus === 'half_day' ? 'Half Day' : displayStatus}
        </span>
      </td>
      <td className="px-2 py-3 text-emerald-400 font-mono text-xs text-center">
         <LiveDuration initialSeconds={record.total_work_seconds} status={resolvedLiveStatus} type="work" isToday={isRecordActive} />
      </td>
      <td className="px-2 py-3 text-cyan-400 font-mono text-xs text-center">
        <LiveDuration initialSeconds={record.total_break_seconds} status={resolvedLiveStatus} type="break" isToday={isRecordActive} />
      </td>
      <td className="px-2 py-3 text-amber-400 font-mono text-xs text-center">
        <LiveDuration initialSeconds={record.total_idle_seconds} status={resolvedLiveStatus} type="idle" isToday={isRecordActive} />
      </td>
      <td className="px-2 py-3 text-orange-400/90 font-mono text-xs text-center font-bold whitespace-nowrap">
         {record.first_login && record.missing_seconds != null ? (
            <LiveDuration initialSeconds={record.missing_seconds} status={resolvedLiveStatus} type="gap" isToday={isRecordActive} isWithinShift={isCalculating} />
         ) : '—'}
      </td>
      <td className="px-2 py-3 text-center">
        {record.is_flagged ? (
          <span className="text-rose-400 font-bold text-[10px] flex items-center justify-center gap-1 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20 uppercase tracking-tighter" title={record.flag_reason}>
            <FlagIcon className="h-3 w-3" /> Alert
          </span>
        ) : (
          <span className="text-slate-600 font-mono text-sm text-center">—</span>
        )}
      </td>
      <td className="px-2 py-3 text-slate-400 text-[10px] italic truncate max-w-[150px] text-center">
        {record.manager_remark || record.flag_reason || '—'}
      </td>
      {user?.role === 'admin' && (
        <td className="px-2 py-3 text-center">
          <div className="flex items-center justify-center gap-1">
            <button onClick={() => handleOverride(record, 'present')} className="w-6 h-6 flex items-center justify-center bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px] font-bold rounded hover:bg-emerald-500/20" title="Mark Present">P</button>
            <button onClick={() => handleOverride(record, 'half_day')} className="w-6 h-6 flex items-center justify-center bg-sky-500/10 text-sky-400 border border-sky-500/20 text-[10px] font-bold rounded hover:bg-sky-500/20" title="Mark Half Day">H</button>
            <button onClick={() => handleOverride(record, 'absent')} className="w-6 h-6 flex items-center justify-center bg-rose-500/10 text-rose-400 border border-rose-500/20 text-[10px] font-bold rounded hover:bg-rose-500/20" title="Mark Absent">A</button>
          </div>
        </td>
      )}
    </tr>
  );
});


const ShiftTable = ({ title, records, lastUpdated, fetchData, loading, dateFilter, startDate, endDate, handleOverride, user, liveStatuses }) => {
  const { currentData, currentPage, totalPages, goToPage, nextPage, prevPage } = usePagination(records, 15);
  const todayStr = new Date().toISOString().split('T')[0];

  return (
    <ResponsiveTable title={title}>
      <div className="bg-slate-800/80 p-4 border-b border-slate-700/50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-lg font-medium text-white flex items-center gap-2">
            <ClockIcon className="h-5 w-5 text-indigo-400" />
            {title} - Filtered Records ({records.length})
          </h2>
          {lastUpdated && (
            <span className="text-[10px] text-slate-500 font-mono mt-1 block px-7">
              Last synced: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
        
        <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
          <button 
            onClick={() => fetchData()}
            className="p-2 bg-slate-900/50 hover:bg-slate-700 text-slate-400 hover:text-white rounded-lg border border-slate-700 transition-all flex items-center gap-2"
            title="Manual Refresh"
          >
            <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="text-xs font-medium">Refresh</span>
          </button>
          <div 
            className="text-xs font-mono text-slate-400 bg-slate-900 border border-slate-700 px-3 py-1.5 rounded-lg whitespace-nowrap cursor-help"
            title={dateFilter === 'today' ? format(new Date(), 'MMM dd, yyyy') : ''}
          >
            {dateFilter === 'custom' ? `${startDate} to ${endDate}` : (
              dateFilter === 'today' ? `TODAY (${format(new Date(), 'MMM dd, yyyy')})` : dateFilter.replace('_', ' ').toUpperCase()
            )}
          </div>
        </div>
      </div>

      <table className="w-full text-left text-sm text-slate-300">
        <thead className="text-xs text-slate-400 uppercase bg-slate-900/50 border-b border-slate-700">
          <tr>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Team Member</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Manager</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Timing</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Status</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Work</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Break</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs text-slate-400">Idle</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Gap</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Alerts</th>
            <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Remarks</th>
            {user?.role === 'admin' && (
              <th className="px-2 py-3 font-semibold tracking-wider text-center text-xs">Actions</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700/50">
          {currentData.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-4 py-8 text-center text-slate-500">
                No records found for this shift in the selected timeframe.
              </td>
            </tr>
          ) : (
            currentData.map((record) => {
              const lookupKey = String(record.user || '').toLowerCase();
              const wsStatus = liveStatuses[lookupKey];
              return (
                <ShiftTableRow 
                  key={record.id} 
                  record={record} 
                  user={user} 
                  wsStatus={wsStatus} 
                  handleOverride={handleOverride} 
                  todayStr={todayStr}
                />
              );
            })
          )}
        </tbody>
      </table>
      <PaginationControls 
        currentPage={currentPage}
        totalPages={totalPages}
        goToPage={goToPage}
        nextPage={nextPage}
        prevPage={prevPage}
      />
    </ResponsiveTable>
  );
};

export default ShiftTable;
