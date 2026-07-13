import { useState, useEffect } from 'react';
import api from '../../api/axios';
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';
import usePagination from '../../hooks/usePagination';
import PaginationControls from '../../components/PaginationControls';
import ResponsiveTable from '../../components/ResponsiveTable';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend 
} from 'recharts';
import { ChartBarSquareIcon } from '@heroicons/react/24/outline';

const AdminReports = () => {
  const [teamData, setTeamData] = useState([]);
  const [loading, setLoading] = useState(true);

  const [dateFilter, setDateFilter] = useState('monthly');
  const [startDate, setStartDate] = useState(format(startOfMonth(new Date()), 'yyyy-MM-dd'));
  const [endDate, setEndDate] = useState(format(endOfMonth(new Date()), 'yyyy-MM-dd'));

  useEffect(() => {
    fetchReports();
  }, [startDate, endDate]);

  const fetchReports = async () => {
    try {
      const params = new URLSearchParams({ type: 'team' });
      if (startDate && endDate) {
        params.append('from_date', startDate);
        params.append('to_date', endDate);
      }
      const res = await api.get(`/reports/?${params.toString()}`);
      setTeamData(res.data);
    } catch (error) {
      console.error('Failed to load reports', error);
    } finally {
      setLoading(false);
    }
  };

  const handleQuickSelect = (type) => {
    setDateFilter(type);
    const now = new Date();
    if (type === 'weekly') {
      setStartDate(format(startOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd'));
      setEndDate(format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd'));
    } else if (type === 'monthly') {
      setStartDate(format(startOfMonth(now), 'yyyy-MM-dd'));
      setEndDate(format(endOfMonth(now), 'yyyy-MM-dd'));
    }
  };

  const { currentData, currentPage, totalPages, goToPage, nextPage, prevPage } = usePagination(teamData, 10);

  if (loading) return <div className="text-indigo-400">Loading Reports...</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/20 rounded-lg">
            <ChartBarSquareIcon className="h-6 w-6 text-indigo-400" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Employee Productivity Analytics</h1>
        </div>

        <div className="flex items-center gap-2 bg-slate-800/50 p-2 rounded-xl border border-slate-700/50">
          <select 
            value={dateFilter}
            onChange={(e) => handleQuickSelect(e.target.value)}
            className="bg-slate-900 border border-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500"
          >
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

      <div className="bg-slate-800/50 border border-slate-700 p-6 rounded-2xl">
        <h2 className="text-lg font-semibold text-white mb-6">Average Daily Work & Idle Hours by Employee</h2>
        <div className="h-96 w-full min-w-0" style={{ position: 'relative' }}>
          <ResponsiveContainer width="99%" height="100%" minHeight={300}>
            <BarChart data={teamData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
              <XAxis dataKey="user_name" stroke="#94a3b8" />
              <YAxis yAxisId="left" stroke="#10b981" />
              <YAxis yAxisId="right" orientation="right" stroke="#f59e0b" />
              <Tooltip 
                contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155' }}
                itemStyle={{ color: '#e2e8f0' }}
              />
              <Legend />
              <Bar yAxisId="left" dataKey="avg_work_hours" name="Avg Work (h)" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="right" dataKey="avg_idle_hours" name="Avg Idle (h)" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <ResponsiveTable title="Detailed Attendance Rates">
        <table className="w-full text-left text-sm text-slate-300">
          <thead className="text-xs text-slate-400 uppercase bg-slate-900/50 border-b border-slate-700">
            <tr>
              <th className="px-6 py-4 font-semibold">Employee</th>
              <th className="px-6 py-4 font-semibold text-center">Rate</th>
              <th className="px-6 py-4 font-semibold text-center">Present</th>
              <th className="px-6 py-4 font-semibold text-center">Absent</th>
              <th className="px-6 py-4 font-semibold text-center">Half Days</th>
              <th className="px-6 py-4 font-semibold text-center">On Leave</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {currentData.map((emp) => (
              <tr key={emp.user_id} className="hover:bg-slate-700/20 transition-colors">
                <td className="px-6 py-4 font-medium text-slate-200">{emp.user_name}</td>
                <td className="px-6 py-4 text-center">
                  <span className={`px-2.5 py-1 rounded bg-slate-900 border font-medium
                    ${emp.attendance_rate >= 90 ? 'text-emerald-400 border-emerald-500/30' : 
                      emp.attendance_rate >= 75 ? 'text-amber-400 border-amber-500/30' : 
                      'text-rose-400 border-rose-500/30'}
                  `}>
                    {emp.attendance_rate}%
                  </span>
                </td>
                <td className="px-6 py-4 text-center text-emerald-400">{emp.present}</td>
                <td className="px-6 py-4 text-center text-rose-400">{emp.absent}</td>
                <td className="px-6 py-4 text-center text-amber-400">{emp.half_day}</td>
                <td className="px-6 py-4 text-center text-cyan-400">{emp.on_leave}</td>
              </tr>
            ))}
            {teamData.length === 0 && (
              <tr>
                <td colSpan="6" className="px-6 py-8 text-center text-slate-500">No data available</td>
              </tr>
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
    </div>
  );
};

export default AdminReports;
