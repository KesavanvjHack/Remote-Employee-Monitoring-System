import React, { useState, useEffect } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { QueueListIcon, ClockIcon } from '@heroicons/react/24/outline';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';
import usePagination from '../../hooks/usePagination';
import PaginationControls from '../../components/PaginationControls';

const ActivityLogs = () => {
  const [allLogs, setAllLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState('today');
  const [startDate, setStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  useEffect(() => {
    fetchLogs();
  }, []);

  const handleQuickSelect = (type) => {
    setDateFilter(type);
    const now = new Date();
    if (type === 'today') {
      setStartDate(format(now, 'yyyy-MM-dd'));
      setEndDate(format(now, 'yyyy-MM-dd'));
    } else if (type === 'weekly') {
      setStartDate(format(startOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd'));
      setEndDate(format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd'));
    } else if (type === 'monthly') {
      setStartDate(format(startOfMonth(now), 'yyyy-MM-dd'));
      setEndDate(format(endOfMonth(now), 'yyyy-MM-dd'));
    }
  };

  const fetchLogs = async () => {
    setLoading(true);
    try {
      // Fetch all to ensure consistency across timezones for Today filter
      const [appRes, auditRes] = await Promise.all([
        api.get('/app-logs/'),
        api.get('/audit-logs/')
      ]);
      
      const appLogs = (appRes.data.results || appRes.data).map(log => ({
        ...log,
        type: 'app'
      }));

      // Filter and format audit logs so they don't look like internal API spam
      const friendlyActionMap = {
        'login': 'Logged In',
        'logout': 'Logged Out',
        'create': 'Created Resource',
        'update': 'Updated Resource',
        'delete': 'Deleted Resource',
        'approve': 'Approved Request',
        'reject': 'Rejected Request'
      };

      const auditLogs = (auditRes.data.results || auditRes.data).map(log => {
        let desc = log.description || '';
        if (desc.includes('/api/')) {
          desc = `System event logged for ${log.action_type.toLowerCase()}`;
        }
        
        return {
          id: `audit-${log.id}`,
          app_name: `System Event: ${friendlyActionMap[log.action_type] || log.action_type}`,
          category: 'system',
          duration_seconds: 0,
          timestamp: log.timestamp,
          description: desc,
          type: 'audit'
        };
      });
      
      const combined = [...appLogs, ...auditLogs].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      setAllLogs(combined);
    } catch (err) {
      toast.error('Failed to load activity logs');
    } finally {
      setLoading(false);
    }
  };

  const displayedLogs = React.useMemo(() => {
    return allLogs.filter(log => {
      const logDate = new Date(log.timestamp).toLocaleDateString('en-CA');
      return logDate >= startDate && logDate <= endDate;
    });
  }, [allLogs, startDate, endDate]);

  const { currentData, currentPage, totalPages, goToPage, nextPage, prevPage } = usePagination(displayedLogs, 20);

  return (
    <div className="space-y-6 page-fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <QueueListIcon className="h-6 w-6 text-indigo-400" />
            Activity & App Usage Logs
          </h2>
          <p className="text-slate-400 mt-1">Review your tracked application usage and system events.</p>
        </div>

        {/* Filter Toggle */}
        <div className="flex items-center gap-2 bg-slate-800/50 p-2 rounded-xl border border-slate-700/50">
          <select 
            value={dateFilter}
            onChange={(e) => handleQuickSelect(e.target.value)}
            className="bg-slate-900 border border-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
          >
            <option value="today">Today</option>
            <option value="weekly">This Week</option>
            <option value="monthly">This Month</option>
            <option value="custom">Custom Dates</option>
          </select>
          {dateFilter === 'custom' && (
            <div className="flex items-center gap-2">
              <input 
                type="date" 
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setDateFilter('custom'); }}
                className="bg-slate-900 border border-slate-700 text-slate-300 rounded-lg px-2 py-2 text-sm focus:ring-2 focus:ring-indigo-500 [color-scheme:dark]"
              />
              <span className="text-slate-500">to</span>
              <input 
                type="date" 
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setDateFilter('custom'); }}
                className="bg-slate-900 border border-slate-700 text-slate-300 rounded-lg px-2 py-2 text-sm focus:ring-2 focus:ring-indigo-500 [color-scheme:dark]"
              />
            </div>
          )}
        </div>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden shadow-xl">
        {loading ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-400">
              <thead className="text-xs text-slate-400 uppercase bg-slate-900/50 border-b border-slate-700">
                <tr>
                  <th className="px-6 py-4 font-medium h-12 skeleton-pulse"></th>
                  <th className="px-6 py-4 font-medium h-12 skeleton-pulse"></th>
                  <th className="px-6 py-4 font-medium h-12 skeleton-pulse"></th>
                  <th className="px-6 py-4 font-medium h-12 skeleton-pulse"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {[...Array(5)].map((_, i) => (
                  <tr key={i} className="h-16 skeleton-pulse">
                    <td colSpan="4"></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : displayedLogs.length === 0 ? (
          <div className="p-8 text-center text-slate-400 italic">No activity logs recorded {filter === 'today' ? 'today' : 'yet'}.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-400">
              <thead className="text-xs text-slate-400 uppercase bg-slate-900/50 border-b border-slate-700">
                <tr>
                  <th className="px-6 py-4 font-medium">Application/Website</th>
                  <th className="px-6 py-4 font-medium">Category</th>
                  <th className="px-6 py-4 font-medium">Duration</th>
                  <th className="px-6 py-4 font-medium">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {currentData.map(log => (
                  <tr key={log.id} className="hover:bg-slate-750/50 transition-colors">
                    <td className="px-6 py-4 font-medium text-slate-200">
                      {log.url && log.type === 'app' ? (
                        <a href={log.url} target="_blank" rel="noopener noreferrer" className="hover:text-indigo-400 underline decoration-indigo-500/30 underline-offset-4">
                          {log.app_name}
                        </a>
                      ) : (
                        log.app_name
                      )}
                      {log.type === 'audit' && <div className="text-xs text-slate-500 font-normal mt-0.5">{log.description}</div>}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-semibold
                        ${log.category === 'productive' ? 'bg-emerald-500/10 text-emerald-400' : 
                          log.category === 'unproductive' ? 'bg-rose-500/10 text-rose-400' : 
                          log.category === 'system' ? 'bg-indigo-500/10 text-indigo-400' :
                          'bg-slate-500/10 text-slate-400'}`}>
                        {log.category ? log.category.charAt(0).toUpperCase() + log.category.slice(1) : 'Neutral'}
                      </span>
                    </td>
                    <td className="px-6 py-4 flex items-center gap-2">
                      <ClockIcon className="h-4 w-4 text-slate-500" />
                      {log.type === 'audit' ? 'Instant' : `${Math.floor((log.duration_seconds || 0) / 60)} mins`}
                    </td>
                    <td className="px-6 py-4">{new Date(log.timestamp).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && displayedLogs.length > 0 && (
          <PaginationControls 
            currentPage={currentPage}
            totalPages={totalPages}
            goToPage={goToPage}
            nextPage={nextPage}
            prevPage={prevPage}
          />
        )}
      </div>
    </div>
  );
};

export default ActivityLogs;
