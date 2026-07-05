"""
Business logic service layer for REMS.
All complex logic lives here; views remain thin.
"""

import os
from datetime import date, datetime, timedelta
from django.utils import timezone
from django.db import transaction
from django.db.models import Sum, Q
from django.core.cache import cache
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
import logging

logger = logging.getLogger(__name__)


def get_client_ip(request):
    """Extract the real client IP from request headers."""
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        return x_forwarded_for.split(',')[0].strip()
    return request.META.get('REMOTE_ADDR')


def get_device_info(request):
    """Capture basic device fingerprint from User-Agent."""
    return request.META.get('HTTP_USER_AGENT', 'Unknown Device')[:500]


# ── Notification Engine ────────────────────────────────────────────────────────
class NotificationService:
    @staticmethod
    def _send_notifications(sender, recipients_qs, title, message, notif_type):
        """Internal helper: bulk-create notifications, broadcast over WebSocket, and send email alerts."""
        from .models import Notification
        from django.core.mail import send_mail
        from django.conf import settings
        
        notifications = [
            Notification(
                recipient=recipient,
                sender=sender,
                type=notif_type,
                title=title,
                message=message
            )
            for recipient in recipients_qs
        ]
        if not notifications:
            return
        try:
            created = Notification.objects.bulk_create(notifications)
            channel_layer = get_channel_layer()
            if channel_layer:
                for notif in created:
                    async_to_sync(channel_layer.group_send)(
                        'status_updates',
                        {
                            'type': 'notification_alert',
                            'notification_id': str(notif.id),
                            'recipient_id': str(notif.recipient.id),
                            'title': notif.title,
                            'message': notif.message,
                            'notif_type': notif.type,
                            'sender_name': sender.full_name
                        }
                    )
            
            # Send an email notification for every created notification record
            for notif in created:
                try:
                    subject = f"[REMS] {notif.title}"
                    html_message = f"""
                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);">
                        <h2 style="color: #1e3a8a; margin-top: 0; font-weight: 700; font-size: 20px; letter-spacing: -0.025em;">REMS Notification Alert</h2>
                        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin-bottom: 20px;"/>
                        <p style="font-size: 15px; color: #334155; line-height: 1.6;">
                            Hello <strong>{notif.recipient.first_name}</strong>,
                        </p>
                        <div style="background-color: #f8fafc; padding: 18px; border-left: 4px solid #3b82f6; border-radius: 6px; margin: 20px 0;">
                            <p style="font-size: 16px; font-weight: 600; color: #0f172a; margin-top: 0; margin-bottom: 8px;">
                                {notif.title}
                            </p>
                            <p style="font-size: 14px; color: #475569; margin: 0; white-space: pre-wrap; line-height: 1.5;">
                                {notif.message}
                            </p>
                        </div>
                        <p style="font-size: 14px; color: #64748b; line-height: 1.6; margin-bottom: 25px;">
                            <strong>Sent By:</strong> {sender.full_name} ({sender.role.upper()})<br/>
                            <strong>Category:</strong> {notif.get_type_display()}
                        </p>
                        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin-top: 20px; margin-bottom: 20px;"/>
                        <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0; line-height: 1.4;">
                            This is an automated system email dispatched from the Remote Employee Monitoring System (REMS). Please do not reply directly to this mailbox.
                        </p>
                    </div>
                    """
                    text_message = f"Hello {notif.recipient.first_name},\n\nYou have received a new notification in REMS:\n\n{notif.title}\n\n{notif.message}\n\nSender: {sender.full_name} ({sender.role.upper()})\nType: {notif.get_type_display()}\n\n---\nThis is an automated system email from REMS."
                    
                    def send_async_email(subj, msg, from_em, to_em, html_msg):
                        try:
                            send_mail(
                                subject=subj,
                                message=msg,
                                from_email=from_em,
                                recipient_list=to_em,
                                html_message=html_msg,
                                fail_silently=True,
                            )
                        except Exception as mail_err:
                            logger.error(f"Failed to send email notification to {to_em[0]}: {mail_err}")
                    
                    import threading
                    threading.Thread(
                        target=send_async_email,
                        args=(
                            subject,
                            text_message,
                            settings.DEFAULT_FROM_EMAIL if hasattr(settings, 'DEFAULT_FROM_EMAIL') else 'noreply@rems.com',
                            [notif.recipient.email],
                            html_message
                        )
                    ).start()
                except Exception as e:
                    logger.error(f"Failed to queue email notification: {e}")
        except Exception as e:
            logger.error(f"Notification processing failed: {e}")

    @staticmethod
    def notify_based_on_role(user, title, message, notif_type='system', sender=None):
        """
        Notify appropriate superiors based on the user's role:
        - Employee -> Manager & Admins
        - Manager -> Admins
        Args:
            user: The user whose superiors should be notified.
            title: notification title
            message: notification message
            notif_type: 'system', 'status', etc.
            sender: The user who triggered the notification (defaults to 'user' if not provided).
        """
        from .models import User
        if sender is None:
            sender = user

        if user.role == 'employee':
            recipients = User.objects.filter(
                Q(id=user.manager_id) | Q(role='admin')
            ).exclude(id=sender.id).distinct()
        elif user.role == 'manager':
            recipients = User.objects.filter(role='admin').exclude(id=sender.id).distinct()
        else:
            recipients = User.objects.none()
            
        if recipients.exists():
            NotificationService._send_notifications(sender, recipients, title, message, notif_type)

    @staticmethod
    def notify_shift_event(user, title, message, notif_type='status'):
        """
        Notify Employee, their Manager, and all Admins about a shift-related event.
        """
        from .models import User
        recipients = User.objects.filter(
            Q(id=user.id) |  # Employee
            Q(id=user.manager_id) |  # Manager
            Q(role='admin')  # Admins
        ).distinct()
        
        # If no sender is provided, use the user themselves as the logical 'source' of the event
        NotificationService._send_notifications(user, recipients, title, message, notif_type)

    @staticmethod
    def notify_attendance_override(admin_user, employee, date_str, new_status):
        """
        Notify Employee and their Manager about an attendance status override.
        """
        from .models import User
        recipients = User.objects.filter(
            Q(id=employee.id) | 
            Q(id=employee.manager_id)
        ).distinct()
        
        title = "Attendance Status Updated"
        message = f"Admin {admin_user.full_name} has updated the attendance status for {employee.full_name} on {date_str} to '{new_status}'."
        
        NotificationService._send_notifications(admin_user, recipients, title, message, 'system')

    @staticmethod
    def notify_all_active_users(sender, title, message, notif_type='system'):
        """
        Notify all active users in the system (e.g. for global policy changes).
        """
        from .models import User
        recipients = User.objects.filter(is_active=True).exclude(id=sender.id)
        if recipients.exists():
            NotificationService._send_notifications(sender, recipients, title, message, notif_type)

    @staticmethod
    def notify_managers_and_admins(sender, title, message, notif_type='system'):
        """
        Notify all managers and administrators in the system.
        """
        from .models import User
        recipients = User.objects.filter(
            role__in=['manager', 'admin'], 
            is_active=True
        ).exclude(id=sender.id).distinct()
        if recipients.exists():
            NotificationService._send_notifications(sender, recipients, title, message, notif_type)

# ── Attendance Engine ──────────────────────────────────────────────────────────

def get_user_policy(user):
    """
    Get the active attendance policy for a user's department,
    falling back to the global active policy.
    """
    from core.models import AttendancePolicy
    if not user:
        return AttendancePolicy.objects.filter(is_active=True, department__isnull=True).first()
    
    policy = None
    if hasattr(user, 'department') and user.department:
        policy = AttendancePolicy.objects.filter(is_active=True, department=user.department).first()
    if not policy:
        policy = AttendancePolicy.objects.filter(is_active=True, department__isnull=True).first()
    return policy


def get_user_shift_times(user, policy=None):
    """
    Get shift start and end times for a user.
    Falls back to department/global policy shift start and end times if no active shift is assigned.
    """
    if not policy:
        policy = get_user_policy(user)
    if user and hasattr(user, 'shift') and user.shift and user.shift.is_active:
        return user.shift.start_time, user.shift.end_time
    if policy:
        return policy.shift_start_time, policy.shift_end_time
    from datetime import time
    return time(9, 30), time(17, 30)


def get_current_shift_date(user, now_dt=None):
    """
    Get the correct shift date for a user based on the current time.
    For overnight shifts, if the current time is after midnight but before the shift ends,
    the shift date is the previous calendar day.
    """
    from datetime import date, timedelta
    from django.utils import timezone
    if not now_dt:
        now_dt = timezone.localtime(timezone.now())
    
    policy = get_user_policy(user)
    s_time, e_time = get_user_shift_times(user, policy)
    
    current_date = now_dt.date()
    if s_time > e_time:
        # Overnight shift
        if now_dt.time() <= e_time:
            current_date -= timedelta(days=1)
            
    return current_date



class AttendanceService:
    """Core attendance engine. Status derived solely from time calculations."""


    @staticmethod
    @transaction.atomic
    def get_or_create_today(user):
        """Called on login. Creates attendance record for the active shift date if not exists."""
        from .models import Attendance, Holiday

        shift_date = get_current_shift_date(user)

        # Check if shift_date is a holiday
        holiday = Holiday.objects.filter(date=shift_date).first()
        if holiday:
            default_status = Attendance.STATUS_HOLIDAY
            default_remark = f"Holiday: {holiday.name}"
        else:
            default_status = Attendance.STATUS_ABSENT
            default_remark = ""

        attendance, created = Attendance.objects.get_or_create(
            user=user,
            date=shift_date,
            defaults={
                'status': default_status,
                'manager_remark': default_remark
            }
        )
        return attendance, created

    @staticmethod
    @transaction.atomic
    def recalculate_status(attendance):
        """
        Recalculate total work/break/idle seconds and set status.
        Uses Interval Union math to prevent any 'double counting' of overlapping sessions.
        """
        from .models import AttendancePolicy

        now = timezone.now()
        sessions = list(attendance.work_sessions.all())
        
        def merge_intervals(intervals):
            if not intervals: return []
            intervals.sort(key=lambda x: x[0])
            merged = [list(intervals[0])]
            for next_start, next_end in intervals[1:]:
                prev_start, prev_end = merged[-1]
                if next_start < prev_end:
                    merged[-1][1] = max(prev_end, next_end)
                else:
                    merged.append([next_start, next_end])
            return merged

        def sum_intervals(intervals):
            return sum((end - start).total_seconds() for start, end in intervals)

        # 1. Total Work Intervals (Union of all work sessions)
        work_intervals = merge_intervals([(s.start_time, s.end_time or now) for s in sessions if (s.end_time or now) > s.start_time])
        total_work = int(sum_intervals(work_intervals))

        # 2. Total Break Intervals (Union of all breaks, intersected with work)
        all_breaks = []
        for s in sessions:
            ws_start, ws_end = s.start_time, s.end_time or now
            for b in s.break_sessions.all():
                bs_start, bs_end = b.start_time, b.end_time or now
                # Intersection with work session
                eff_start = max(bs_start, ws_start)
                eff_end = min(bs_end, ws_end)
                if eff_end > eff_start:
                    all_breaks.append((eff_start, eff_end))
        total_break = int(sum_intervals(merge_intervals(all_breaks)))

        # 3. Total Idle Intervals (Union of all idles, intersected with work)
        all_idles = []
        for s in sessions:
            ws_start, ws_end = s.start_time, s.end_time or now
            for i in s.idle_logs.all():
                il_start, il_end = i.start_time, i.end_time or now
                # Intersection with work session
                eff_start = max(il_start, ws_start)
                eff_end = min(il_end, ws_end)
                if eff_end > eff_start:
                    all_idles.append((eff_start, eff_end))
        total_idle = int(sum_intervals(merge_intervals(all_idles)))

        # 4. OVERLAP PROTECTION: Unified Unproductive Duration
        # Merge breaks and idles into a single union to prevent double-subtracting overlapping time
        unproductive_union = merge_intervals(all_breaks + all_idles)
        total_unproductive_seconds = int(sum_intervals(unproductive_union))

        # 5. Net Arithmetic Accuracy (Gross Perspective)
        net_work_seconds = max(0, total_work - total_unproductive_seconds)
        
        # 6. Shift Window Policy (Strictness Integration)
        try:
            policy = get_user_policy(attendance.user)
            present_hours = float(policy.present_hours) if policy else 8.0
            min_hours = float(policy.min_working_hours) if policy else 8.0
            half_day_hours = float(policy.half_day_hours) if policy else 4.0
            idle_threshold_minutes = policy.idle_threshold_minutes if policy else 15
            
            # 6a. Define Shift Window for the specific attendance date
            att_date = attendance.date
            tz = timezone.get_current_timezone()
            s_time, e_time = get_user_shift_times(attendance.user, policy)
            shift_start_dt = timezone.make_aware(datetime.combine(att_date, s_time), tz)
            shift_end_dt = timezone.make_aware(datetime.combine(att_date, e_time), tz)
            if shift_end_dt <= shift_start_dt: shift_end_dt += timedelta(days=1)
        except Exception:
            policy = None
            present_hours, min_hours, half_day_hours, idle_threshold_minutes = 8.0, 8.0, 4.0, 15
            shift_start_dt = shift_end_dt = None

        # 7. Shift Intersection Math (Official Attendance Grade)
        shift_work_seconds = 0
        net_shift_work_seconds = 0
        if shift_start_dt and shift_end_dt:
            # Shift Work Union
            for start, end in work_intervals:
                win_start = max(start, shift_start_dt)
                win_end = min(end, shift_end_dt)
                if win_end > win_start:
                    shift_work_seconds += (win_end - win_start).total_seconds()
            
            # Unproductive Intersection within Shift
            shift_unproductive_seconds = 0
            for start, end in unproductive_union:
                win_start = max(start, shift_start_dt)
                win_end = min(end, shift_end_dt)
                if win_end > win_start:
                    shift_unproductive_seconds += (win_end - win_start).total_seconds()
            
            net_shift_work_seconds = max(0, shift_work_seconds - shift_unproductive_seconds)
        else:
            net_shift_work_seconds = net_work_seconds

        # 8. Status Determination (Based on Shift-Aware Net Hours)
        total_work_hours = net_shift_work_seconds / 3600
        print(f"DEBUG RECALC: total_work_hours={total_work_hours}, present_hours={present_hours}, min_hours={min_hours}, half_day_hours={half_day_hours}")
        
        auto_remark = ""
        if attendance.status in (attendance.STATUS_ON_LEAVE, attendance.STATUS_HOLIDAY):
            status = attendance.status
        elif total_work_hours >= present_hours:
            status = attendance.STATUS_PRESENT
            auto_remark = ""
        elif total_work_hours >= min_hours:
            status = attendance.STATUS_PRESENT
            auto_remark = ""
        elif total_work_hours >= half_day_hours:
            status = attendance.STATUS_HALF_DAY
            auto_remark = f"Shift hours ({total_work_hours:.2f}h) below required {min_hours}h for Full Day."
        elif total_work_hours > 0:
            status = attendance.STATUS_ABSENT
            auto_remark = f"Insufficient work for credit: {total_work_hours:.2f}h recorded within shift (Requirement: {half_day_hours}h for Half-Day)."
        else:
            status = attendance.STATUS_ABSENT
            auto_remark = "No work recorded within shift hours."

        # 9. Dynamic Flagging (Anomalies)
        # Threshold: 50% of total login duration
        idle_percentage = (total_idle / total_work * 100) if total_work > 0 else 0
        should_flag_idle = idle_percentage > 50

        # 10. Persistence
        attendance.total_work_seconds = net_work_seconds
        attendance.total_break_seconds = total_break
        attendance.total_idle_seconds = total_idle
        attendance.status = status

        # Only set automated remark if manager hasn't provided one
        lower_remark = (attendance.manager_remark or "").lower()
        is_auto_remark = not attendance.manager_remark or "hours" in lower_remark or "no work" in lower_remark or "insufficient work" in lower_remark or "below required" in lower_remark
        if is_auto_remark:
            attendance.manager_remark = auto_remark

        # Flagging Logic
        if should_flag_idle:
            attendance.is_flagged = True
            attendance.flag_reason = f'High idle time: {idle_percentage:.1f}% of work time'
        elif attendance.is_flagged and 'High idle time' in (attendance.flag_reason or ''):
            # Clear automatically only if it was an idle flag and now it resolves below 30%
            attendance.is_flagged = False
            attendance.flag_reason = ''
        attendance.save(update_fields=[
            'total_work_seconds', 'total_break_seconds', 'total_idle_seconds',
            'status', 'is_flagged', 'flag_reason', 'manager_remark', 'updated_at'
        ])
        return attendance

    @staticmethod
    @transaction.atomic
    def auto_checkout_all_active_sessions():
        """
        Find all open work sessions that have passed their shift end time.
        Close them and notify all roles.
        """
        from .models import WorkSession
        import datetime
        
        now_local = timezone.localtime(timezone.now())
        tz = timezone.get_current_timezone()
        
        open_sessions = WorkSession.objects.filter(
            end_time__isnull=True
        ).select_related('attendance__user')
        
        count = 0
        for session in open_sessions:
            user = session.attendance.user
            if user.role == 'admin':
                continue
            policy = get_user_policy(user)
            if not policy:
                continue
            
            s_time, e_time = get_user_shift_times(user, policy)
            session_date = session.attendance.date
            
            # Construct shift end datetime for this session
            close_time = timezone.make_aware(datetime.datetime.combine(session_date, e_time), tz)
            if s_time > e_time:
                close_time += datetime.timedelta(days=1)
                
            if now_local >= close_time:
                WorkSessionService.stop_session(user, end_time=close_time, is_auto=True, session=session)
                count += 1
        return count


    @staticmethod
    def notify_upcoming_shifts():
        """
        Notify employees 15 minutes before their shift starts.
        Deduplicates notifications to ensure only one alert per day per user.
        """
        from .models import User, Notification
        import datetime
        
        now_local = timezone.localtime(timezone.now())
        today = now_local.date()
        
        # Check window: Shifts starting in the next 15 minutes
        window_start = now_local.time()
        window_end = (now_local + datetime.timedelta(minutes=15)).time()
        
        users = User.objects.filter(is_active=True, role='employee').select_related('shift', 'department')
        
        notified_count = 0
        for user in users:
            s_time, _ = get_user_shift_times(user)
            if window_start <= s_time <= window_end:
                from .models import Attendance
                if Attendance.objects.filter(user=user, date=today).exists():
                    continue
                    
                already_notified = Notification.objects.filter(
                    recipient=user,
                    title="Shift Starting Soon",
                    created_at__date=today
                ).exists()
                
                if not already_notified:
                    NotificationService._send_notifications(
                        user, [user],
                        "Shift Starting Soon",
                        f"Reminder: Your shift starts at {s_time.strftime('%I:%M %p')}. Please log in.",
                        "system"
                    )
                    notified_count += 1
                    
        return notified_count


# ── Work Session Service ───────────────────────────────────────────────────────

class WorkSessionService:

    @staticmethod
    @transaction.atomic
    def start_session(user, request):
        """Start a new work session for the user. Create attendance if needed."""
        from .models import WorkSession, Attendance, AttendancePolicy
        import datetime

        policy = get_user_policy(user)
        now_local = timezone.localtime(timezone.now())
        
        # 1. Enforce shift start time constraint
        s_time, e_time = get_user_shift_times(user, policy)
        start_dt = now_local.replace(hour=s_time.hour, minute=s_time.minute, second=0, microsecond=0)
        end_dt = now_local.replace(hour=e_time.hour, minute=e_time.minute, second=0, microsecond=0)
        
        is_within = False
        if end_dt <= start_dt:
            # Overnight shift
            end_next = end_dt + datetime.timedelta(days=1)
            start_yesterday = start_dt - datetime.timedelta(days=1)
            is_within = (start_dt <= now_local <= end_next) or (start_yesterday <= now_local <= end_dt)
        else:
            is_within = start_dt <= now_local <= end_dt
            
        if not is_within:
            raise ValueError(f"Shift has not started yet. Work is only allowed during shift hours.")

        attendance, _ = AttendanceService.get_or_create_today(user)
        # Sequence lock on parent attendance to prevent double-click creation races
        Attendance.objects.select_for_update().get(id=attendance.id)

        # 2. Enforce one-session-per-day constraint (disable after checkout)
        completed_sessions = WorkSession.objects.filter(
            attendance=attendance,
            end_time__isnull=False
        ).exists()
        if completed_sessions:
            raise ValueError("You have already checked out for today. New sessions are restricted until tomorrow.")

        # Check if there's already an open session
        open_session = WorkSession.objects.filter(
            attendance=attendance,
            end_time__isnull=True
        ).first()
        if open_session:
            return open_session, False  # already running

        session = WorkSession.objects.create(
            attendance=attendance,
            start_time=timezone.now(),
            ip_address=get_client_ip(request),
            device_info=get_device_info(request),
        )
        AuditService.log(user, 'create', 'Work session started', request)
        StatusService.broadcast_status_change(user)
        time_str = timezone.localtime(timezone.now()).strftime("%I:%M %p")
        NotificationService.notify_shift_event(
            user, "Shift Started", f"{user.full_name} started their shift at {time_str}."
        )
        return session, True

    @staticmethod
    @transaction.atomic
    def stop_session(user, end_time=None, is_auto=False, session=None):
        """Stop the active work session and recalculate status."""
        from .models import WorkSession, Attendance

        if session:
            open_session = session
        else:
            # Find the open session for this user. 
            # If there are multiple (which shouldn't happen), we pick the oldest one.
            open_session = WorkSession.objects.filter(
                attendance__user=user,
                end_time__isnull=True
            ).order_by('start_time').first()

        if not open_session:
            return None, False

        attendance = open_session.attendance
        # Sequence lock on parent attendance to prevent double-click creation races
        Attendance.objects.select_for_update().get(id=attendance.id)

        # Capping Logic: If not admin, cap end_time to shift_end_time if it has passed
        stop_time = end_time if end_time else timezone.now()
        
        if user.role != 'admin':
            from .models import AttendancePolicy
            import datetime
            policy = get_user_policy(user)
            if policy:
                # Use the date of the attendance record, not necessarily 'today'
                # to handle sessions that were left open from previous days.
                session_date = attendance.date
                s_time, e_time = get_user_shift_times(user, policy)
                shift_end_dt = timezone.make_aware(datetime.datetime.combine(session_date, e_time))
                if s_time > e_time:
                    shift_end_dt += datetime.timedelta(days=1)
                
                if stop_time > shift_end_dt:
                    stop_time = shift_end_dt
                    is_auto = True # Mark as auto if we capped it

        # Ensure stop_time is NOT before start_time to prevent negative duration
        if stop_time < open_session.start_time:
            stop_time = open_session.start_time
            is_auto = True

        # Also close any open break
        open_break = open_session.break_sessions.filter(end_time__isnull=True).first()
        if open_break:
            open_break.end_time = stop_time
            open_break.save(update_fields=['end_time', 'updated_at'])

        # Close any open idle log
        open_idle = open_session.idle_logs.filter(end_time__isnull=True).first()
        if open_idle:
            open_idle.end_time = stop_time
            open_idle.save(update_fields=['end_time', 'updated_at'])

        open_session.end_time = stop_time
        open_session.save(update_fields=['end_time', 'updated_at'])

        # SYNC: Also close any active Monitoring (Screen Share) session
        try:
            from monitoring.models import MonitoringSession
            MonitoringSession.objects.filter(employee=user, is_active=True).update(is_active=False)
        except ImportError:
            pass # Monitoring app might not be installed or enabled

        AttendanceService.recalculate_status(attendance)
        StatusService.broadcast_status_change(user)
        
        time_str = timezone.localtime(stop_time).strftime("%I:%M %p")
        msg_suffix = " (Auto-Checkout)" if is_auto else ""
        NotificationService.notify_shift_event(
            user, 
            "Shift Ended" + msg_suffix, 
            f"{user.full_name} clocked out at {time_str}{msg_suffix}."
        )
        return open_session, True


# ── Break Session Service ──────────────────────────────────────────────────────

class BreakSessionService:

    @staticmethod
    @transaction.atomic
    def start_break(user):
        """Start a break within the active work session."""
        from .models import WorkSession, BreakSession, Attendance

        attendance, _ = AttendanceService.get_or_create_today(user)
        # Sequence lock on parent attendance to prevent double-click creation races
        Attendance.objects.select_for_update().get(id=attendance.id)

        open_session = WorkSession.objects.filter(
            attendance=attendance,
            end_time__isnull=True
        ).first()

        if not open_session:
            raise ValueError('No active work session. Start work first.')

        # Check no break already running
        existing_break = open_session.break_sessions.filter(end_time__isnull=True).first()
        if existing_break:
            return existing_break, False

        # Close any open idle log before starting break
        open_idle = open_session.idle_logs.filter(end_time__isnull=True).first()
        if open_idle:
            open_idle.end_time = timezone.now()
            open_idle.save(update_fields=['end_time', 'updated_at'])

        break_session = BreakSession.objects.create(
            work_session=open_session,
            start_time=timezone.now(),
        )
        StatusService.broadcast_status_change(user)
        NotificationService.notify_shift_event(
            user, "On Break", f"{user.full_name} started a break.", "status"
        )
        return break_session, True

    @staticmethod
    @transaction.atomic
    def stop_break(user):
        """End the active break."""
        from .models import WorkSession

        attendance, _ = AttendanceService.get_or_create_today(user)
        open_session = WorkSession.objects.select_for_update().filter(
            attendance=attendance,
            end_time__isnull=True
        ).first()

        if not open_session:
            return None, False

        open_break = open_session.break_sessions.filter(end_time__isnull=True).first()
        if not open_break:
            return None, False

        open_break.end_time = timezone.now()
        open_break.save(update_fields=['end_time', 'updated_at'])
        AttendanceService.recalculate_status(attendance)
        StatusService.broadcast_status_change(user)
        NotificationService.notify_shift_event(
            user, "Back from Break", f"{user.full_name} returned from break.", "status"
        )
        return open_break, True


# ── Idle Log Service ───────────────────────────────────────────────────────────

class IdleService:

    @staticmethod
    @transaction.atomic
    def start_idle(user, start_time=None, reason=None):
        """
        Mark user as idle.
        """
        from .models import WorkSession, IdleLog, AttendancePolicy
        import datetime

        # 1. Enforce shift hours (Idle detection only during shift)
        policy = get_user_policy(user)
        s_time, e_time = get_user_shift_times(user, policy)
        now_local = timezone.localtime(timezone.now())
        
        # Handle overnight shifts
        if s_time <= e_time:
            within = s_time <= now_local.time() <= e_time
        else:
            within = now_local.time() >= s_time or now_local.time() <= e_time
            
        if not within:
            # Outside shift hours — ignore idle detection request
            return None, False

        attendance, _ = AttendanceService.get_or_create_today(user)
        open_session = WorkSession.objects.filter(
            attendance=attendance,
            end_time__isnull=True
        ).first()

        if not open_session:
            return None, False

        # Prevent idle during an active break
        on_break = open_session.break_sessions.filter(end_time__isnull=True).exists()
        if on_break:
            return None, False

        existing_idle = open_session.idle_logs.select_for_update().filter(end_time__isnull=True).first()
        if existing_idle:
            return existing_idle, False

        # Use provided start_time (retroactive) or current time
        new_start = timezone.now()
        if start_time:
            from django.utils.dateparse import parse_datetime
            if isinstance(start_time, str):
                parsed = parse_datetime(start_time)
                if parsed:
                    new_start = parsed
            else:
                new_start = start_time

        idle_log = IdleLog.objects.create(
            work_session=open_session,
            start_time=new_start,
        )
        
        if reason == 'screen_disconnected':
            title = "Screen Disconnected"
            msg = f"{user.full_name} is now Idle (Screen share disconnected after refresh)."
        else:
            threshold_msg = f"after {policy.idle_threshold_minutes} minutes" if policy else "after threshold"
            title = "Idle Detected"
            msg = f"{user.full_name} is now Idle ({threshold_msg} of inactivity)."

        # 1. Notify Employee, Manager, and Admins
        NotificationService.notify_shift_event(user, title, msg, "status")
        
        # 2. Broadcast status change to Live Dashboards
        StatusService.broadcast_status_change(user)

        return idle_log, True

    @staticmethod
    @transaction.atomic
    def stop_idle(user):
        """Resume from idle. Called when user moves mouse/types."""
        from .models import WorkSession

        attendance, _ = AttendanceService.get_or_create_today(user)
        open_session = WorkSession.objects.filter(
            attendance=attendance,
            end_time__isnull=True
        ).first()

        if not open_session:
            return None, False

        open_idle = open_session.idle_logs.select_for_update().filter(end_time__isnull=True).first()
        if not open_idle:
            return None, False

        open_idle.end_time = timezone.now()
        open_idle.save(update_fields=['end_time', 'updated_at'])
        AttendanceService.recalculate_status(attendance)
        StatusService.broadcast_status_change(user)
        NotificationService.notify_shift_event(
            user, "Back to Work", f"{user.full_name} has returned to work.", "status"
        )
        return open_idle, True


# ── Real-Time Status Service ───────────────────────────────────────────────────

class StatusService:

    @staticmethod
    def touch_presence(user_id):
        """Force presence to true for 35s. Useful when user makes an active HTTP request."""
        from django.core.cache import cache
        cache.set(f'presence_{str(user_id)}', True, 35)

    @staticmethod
    def broadcast_status_change(user):
        """Helper to push the current status of a user over Django Channels."""
        try:
            # If we are broadcasting because of a user action, ensure presence is active
            StatusService.touch_presence(user.id)
            
            channel_layer = get_channel_layer()
            status_data = StatusService.get_user_status(user)
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    'status_updates',
                    {
                        'type': 'status_update',
                        'user_id': str(user.id),
                        'status': status_data['status']
                    }
                )
        except Exception as e:
            logger.error(f"WebSocket broadcast failed: {e}")

    @staticmethod
    def broadcast_policy_update():
        """Broadcast to all users that the attendance policy has changed."""
        try:
            channel_layer = get_channel_layer()
            if channel_layer:
                async_to_sync(channel_layer.group_send)(
                    'status_updates',
                    {
                        'type': 'policy_update',
                        'message': 'Full policy refresh required'
                    }
                )
        except Exception as e:
            logger.error(f"Policy broadcast failed: {e}")

    @staticmethod
    def get_users_statuses(users, target_date=None):
        """
        Return a dict of user_id -> status_dict for multiple users in bulk (5 queries total).
        """
        from .models import Attendance, WorkSession, BreakSession, IdleLog
        from django.core.cache import cache
        if not target_date:
            target_date = date.today()

        user_ids = [u.id for u in users]

        # 1. Fetch all open work sessions for these users (supporting overnight shifts)
        open_sessions = WorkSession.objects.filter(
            attendance__user_id__in=user_ids,
            end_time__isnull=True
        ).select_related('attendance')
        open_session_map = {str(s.attendance.user_id): s for s in open_sessions}

        # Determine which users do not have an open session, to fetch their target_date attendance
        users_without_open = [u_id for u_id in user_ids if str(u_id) not in open_session_map]

        # 2. Fetch target_date attendances only for users without open sessions
        attendances = Attendance.objects.filter(user_id__in=users_without_open, date=target_date)
        att_map = {str(a.user_id): a for a in attendances}

        # 3. Fetch all open breaks for these open sessions
        open_breaks = BreakSession.objects.filter(
            work_session__in=open_sessions,
            end_time__isnull=True
        )
        break_map = {str(b.work_session_id): b for b in open_breaks}

        # 4. Fetch all open idle logs for these open sessions
        open_idles = IdleLog.objects.filter(
            work_session__in=open_sessions,
            end_time__isnull=True
        )
        idle_map = {str(i.work_session_id): i for i in open_idles}

        # 5. Fetch all presence keys in bulk using Django cache (cache keys are string UUIDs)
        presence_keys = [f'presence_{str(u_id)}' for u_id in user_ids]
        cached_presence = cache.get_many(presence_keys) if hasattr(cache, 'get_many') else {}
        if not cached_presence:
            cached_presence = {k: cache.get(k) for k in presence_keys}

        statuses = {}
        for user in users:
            u_id_str = str(user.id)
            if user.role == 'admin':
                status_data = {'status': 'working', 'attendance': None, 'session': None}
                statuses[user.id] = status_data
                statuses[u_id_str] = status_data
                continue

            # Prioritize presence: If not online, they are offline
            is_online = cached_presence.get(f'presence_{u_id_str}')
            if not is_online:
                att = att_map.get(u_id_str)
                # Fallback to session attendance if present
                if not att:
                    session = open_session_map.get(u_id_str)
                    if session:
                        att = session.attendance
                status_data = {'status': 'offline', 'attendance': att, 'session': None}
                statuses[user.id] = status_data
                statuses[u_id_str] = status_data
                continue

            session = open_session_map.get(u_id_str)
            if session:
                att = session.attendance
                # Check break
                ob = break_map.get(str(session.id))
                if ob:
                    status_data = {'status': 'on_break', 'attendance': att, 'session': session}
                    statuses[user.id] = status_data
                    statuses[u_id_str] = status_data
                    continue
                # Check idle
                oi = idle_map.get(str(session.id))
                if oi:
                    status_data = {'status': 'idle', 'attendance': att, 'session': session}
                    statuses[user.id] = status_data
                    statuses[u_id_str] = status_data
                    continue
                status_data = {'status': 'working', 'attendance': att, 'session': session}
                statuses[user.id] = status_data
                statuses[u_id_str] = status_data
                continue

            # No open session; check target_date attendance
            att = att_map.get(u_id_str)
            status_data = {'status': 'online', 'attendance': att, 'session': None}
            statuses[user.id] = status_data
            statuses[u_id_str] = status_data

        return statuses

    @staticmethod
    def get_user_status(user):
        """
        Return real-time status: online/working/idle/on_break/offline
        """
        from .models import WorkSession, Attendance
        from django.core.cache import cache

        if user.role == 'admin':
            return {'status': 'working', 'attendance': None, 'session': None}

        # Check presence first: If not online, they are offline
        is_online = cache.get(f'presence_{user.id}')
        if not is_online:
            today = date.today()
            attendance = user.attendances.filter(date=today).first()
            return {'status': 'offline', 'attendance': attendance, 'session': None}

        # 1. Look for any active/open session first to support overnight shifts
        open_session = WorkSession.objects.filter(
            attendance__user=user,
            end_time__isnull=True
        ).select_related('attendance').first()

        if open_session:
            attendance = open_session.attendance
            # Check break (Prioritized over idle)
            open_break = open_session.break_sessions.filter(end_time__isnull=True).first()
            if open_break:
                return {'status': 'on_break', 'attendance': attendance, 'session': open_session}

            # Check idle
            open_idle = open_session.idle_logs.filter(end_time__isnull=True).first()
            if open_idle:
                return {'status': 'idle', 'attendance': attendance, 'session': open_session}

            return {'status': 'working', 'attendance': attendance, 'session': open_session}

        # 2. If no open session, use today's attendance record
        today = date.today()
        attendance = user.attendances.filter(date=today).first()
        return {'status': 'online', 'attendance': attendance, 'session': None}


# ── Leave Service ──────────────────────────────────────────────────────────────

class LeaveService:

    @staticmethod
    @transaction.atomic
    def apply_leave(employee, data, request):
        """Employee applies for leave."""
        from .models import LeaveRequest

        leave = LeaveRequest.objects.create(
            employee=employee,
            leave_type=data['leave_type'],
            from_date=data['from_date'],
            to_date=data['to_date'],
            reason=data['reason'],
        )
        AuditService.log(employee, 'create', f'Leave request submitted: {leave.leave_type}', request)
        return leave

    @staticmethod
    @transaction.atomic
    def review_leave(leave_request, reviewer, action, comment, request):
        """Manager/Admin approves or rejects leave."""
        from .models import Attendance, Holiday, LeaveRequest

        if action == 'approve':
            leave_request.status = LeaveRequest.STATUS_APPROVED
            # Mark attendance as on_leave for each date
            d = leave_request.from_date
            while d <= leave_request.to_date:
                is_holiday = Holiday.objects.filter(date=d).exists()
                if not is_holiday:
                    Attendance.objects.update_or_create(
                        user=leave_request.employee,
                        date=d,
                        defaults={
                            'status': Attendance.STATUS_ON_LEAVE,
                            'manager_remark': f"Leave: {leave_request.get_leave_type_display()} - {leave_request.reason or ''}"
                        }
                    )
                d += timedelta(days=1)
        elif action == 'reject':
            leave_request.status = LeaveRequest.STATUS_REJECTED
        else:
            raise ValueError(f'Unknown action: {action}')

        leave_request.reviewed_by = reviewer
        leave_request.review_comment = comment
        leave_request.reviewed_at = timezone.now()
        leave_request.save()

        AuditService.log(
            reviewer, action,
            f'Leave {action}d for {leave_request.employee.email}: {leave_request.id}',
            request
        )
        return leave_request


# ── Reporting Service ──────────────────────────────────────────────────────────

class ReportService:

    @staticmethod
    def get_attendance_summary(user_ids=None, from_date=None, to_date=None):
        """
        Return attendance summary stats.
        user_ids: Optional list of user IDs to filter by.
        """
        from .models import Attendance, AttendancePolicy
        from django.db.models import Sum
        from django.utils import timezone
        import datetime
        import pytz

        today = date.today()
        qs = Attendance.objects.all()
        if user_ids is not None:
            qs = qs.filter(user_id__in=user_ids)
        if from_date:
            qs = qs.filter(date__gte=from_date)
            
        # Cap range to today to avoid future leaves skewing averages
        range_end = to_date if to_date else today
        if isinstance(range_end, str):
            range_end = date.fromisoformat(range_end)
        
        effective_to_date = min(range_end, today)
        qs = qs.filter(date__lte=effective_to_date)

        # Get policy for cutoff check
        policy = AttendancePolicy.objects.first()
        shift_end = policy.shift_end_time if policy else datetime.time(17, 30)
        
        # IST check
        ist = pytz.timezone('Asia/Kolkata')
        now_ist = timezone.now().astimezone(ist)
        is_before_cutoff = now_ist.time() < shift_end

        from .models import User
        
        # Calculate real team composition based on active users, not just attendance records
        user_qs = User.objects.filter(is_active=True)
        if user_ids is not None:
             user_qs = user_qs.filter(id__in=user_ids)
        else:
             # Admin view: only count those that SHOULD be attending (employees/managers)
             user_qs = user_qs.filter(role__in=['manager', 'employee'])
        
        actual_user_count = user_qs.count()

        total_records = qs.count()
        present = qs.filter(status='present').count()
        half_day = qs.filter(status='half_day').count()
        on_leave = qs.filter(status='on_leave').count()
        
        # Absent logic: only count as absent if it's NOT today or if cutoff passed
        absent_qs = qs.filter(status='absent')
        if is_before_cutoff:
            final_absent = absent_qs.exclude(date=today).count()
            calculating = absent_qs.filter(date=today).count()
        else:
            final_absent = absent_qs.count()
            calculating = 0
            
        # If today, some people might be missing attendance entirely
        # (They haven't logged in, and no dummy record created yet)
        if (not from_date or from_date <= today) and (not to_date or to_date >= today):
            missing_today = max(0, actual_user_count - (total_records if total_records > 0 else 0))
            if is_before_cutoff:
                calculating += missing_today
            else:
                final_absent += missing_today

        absent = final_absent
        avg_work = qs.aggregate(avg=Sum('total_work_seconds'))['avg'] or 0
        avg_idle = qs.aggregate(avg=Sum('total_idle_seconds'))['avg'] or 0

        total_score = 0
        scored_days = 0
        if total_records < 200:
            from .models import AttendancePolicy, AppUsageLog
            policy = AttendancePolicy.objects.filter(is_active=True).first()
            
            # Fetch all app usage in bulk for these users/range
            app_usage_qs = AppUsageLog.objects.filter(user_id__in=[att.user_id for att in qs])
            if from_date:
                app_usage_qs = app_usage_qs.filter(timestamp__date__gte=from_date)
            app_usage_qs = app_usage_qs.filter(timestamp__date__lte=effective_to_date)
            
            # Group by user and date
            app_usage_data = app_usage_qs.values('user_id', 'timestamp__date').annotate(total_sec=Sum('duration_seconds'))
            app_usage_map = {(d['user_id'], d['timestamp__date']): d['total_sec'] for d in app_usage_data}
            
            for d_att in qs.select_related('user'):
                user_app_sec = app_usage_map.get((d_att.user_id, d_att.date), 0)
                total_score += ProductivityScoringService.calculate_score(
                    d_att.user, d_att.date, attendance=d_att, policy=policy, app_usage_sec=user_app_sec
                )
                scored_days += 1
        avg_productivity_score = round(total_score / scored_days) if scored_days > 0 else 0

        return {
            'total': actual_user_count,
            'present': present,
            'half_day': half_day,
            'absent': absent,
            'calculating': calculating,
            'on_leave': on_leave,
            'attendance_rate': round(present / actual_user_count * 100, 1) if actual_user_count > 0 else 0,
            'avg_work_hours': round(avg_work / 3600, 2) if total_records > 0 else 0,
            'avg_idle_hours': round(avg_idle / 3600, 2) if total_records > 0 else 0,
            'productivity_score': avg_productivity_score,
        }

    @staticmethod
    def get_daily_data(user_ids=None, days=7):
        """
        Return per-day productivity data for charts.
        user_ids: Optional list of user IDs to filter by.
        """
        from .models import Attendance, User
        from django.db.models import Sum

        end = date.today()
        start = end - timedelta(days=days - 1)

        qs = Attendance.objects.filter(date__range=(start, end))
        if user_ids is not None:
            qs = qs.filter(user_id__in=user_ids)

        result = []
        d = start
        while d <= end:
            day_qs = qs.filter(date=d)
            work_s = day_qs.aggregate(s=Sum('total_work_seconds'))['s'] or 0
            idle_s = day_qs.aggregate(s=Sum('total_idle_seconds'))['s'] or 0
            break_s = day_qs.aggregate(s=Sum('total_break_seconds'))['s'] or 0

            # Performance safety cap: skip scores for massive datasets
            total_day_score = 0
            scored_count = 0
            if qs.count() < 500:
                from .services import ProductivityScoringService
                for att in day_qs.select_related('user'):
                    total_day_score += ProductivityScoringService.calculate_score(att.user, d)
                    scored_count += 1
            daily_score = round(total_day_score / scored_count) if scored_count > 0 else 0

            result.append({
                'date': d.strftime('%Y-%m-%d'),
                'work_hours': round(work_s / 3600, 2),
                'idle_hours': round(idle_s / 3600, 2),
                'break_hours': round(break_s / 3600, 2),
                'productive_hours': round(work_s / 3600, 2),
                'productivity_score': daily_score,
                'present': day_qs.filter(status='present').count(),
                'absent': day_qs.filter(status='absent').count(),
            })
            d += timedelta(days=1)
        return result


# ── Audit Service ──────────────────────────────────────────────────────────────

class AuditService:

    @staticmethod
    def log(user, action_type, description, request=None, extra_data=None):
        """Create an audit log entry."""
        from .models import AuditLog
        try:
            AuditLog.objects.create(
                user=user,
                action_type=action_type,
                description=description,
                ip_address=get_client_ip(request) if request else None,
                user_agent=get_device_info(request) if request else '',
                extra_data=extra_data or {},
            )
        except Exception as e:
            logger.error(f'AuditLog creation failed: {e}')

# ── Productivity & Payroll Services (Phase 10) ─────────────────────────────────

class ProductivityScoringService:
    @staticmethod
    def calculate_score(user, target_date=None, attendance=None, policy=None, app_usage_sec=None):
        """
        Calculates a daily productivity score (0-100) based on:
        - Total work hours (vs policy minimum)
        - Subtracting excessive idle time
        - Penalty for flagged anomalous behavior (too many breaks, unauthorized apps)
        """
        from .models import Attendance, AttendancePolicy, AppUsageLog
        from django.db.models import Sum

        if not target_date:
            target_date = date.today()

        if attendance is None:
            attendance = Attendance.objects.filter(user=user, date=target_date).first()
        if not attendance:
            return 0  # No attendance = 0 score

        # Base score from work hours
        if policy is None:
            try:
                policy = AttendancePolicy.objects.filter(is_active=True).first()
                min_hours = float(policy.min_working_hours) * 3600 if policy else 8 * 3600
            except Exception:
                min_hours = 8 * 3600
        else:
            min_hours = float(policy.min_working_hours) * 3600 if policy else 8 * 3600

        work_sec = attendance.total_work_seconds
        
        # Base proportion of minimum hours (using total work hours as requested)
        score = (work_sec / min_hours) * 100 if min_hours > 0 else 0

        # Penalties: High idle/breaks
        if attendance.is_flagged:
            score -= 15  # Flat penalty for anomalies

        # Penalties: Unauthorized Web/App usage (simulated based on app logs)
        if app_usage_sec is None:
            non_work_apps_sec = AppUsageLog.objects.filter(
                user=user, 
                timestamp__date=target_date
            ).aggregate(s=Sum('duration_seconds'))['s'] or 0
        else:
            non_work_apps_sec = app_usage_sec

        if non_work_apps_sec > 3600:
            score -= 10

        return max(0, min(100, round(score)))


class PayrollPrepService:
    @staticmethod
    def prepare_monthly_payroll(month: int, year: int):
        """
        Aggregate attendance, leaves, and expenses for payroll generation.
        Returns a list of dicts suitable for CSV export via the ExportView.
        """
        from .models import User, Attendance, LeaveRequest, Expense
        from .services import get_user_policy, get_user_shift_times

        start_date = date(year, month, 1)
        if month == 12:
            end_date = date(year + 1, 1, 1) - timedelta(days=1)
        else:
            end_date = date(year, month + 1, 1) - timedelta(days=1)

        payroll_data = []
        users = User.objects.filter(is_active=True)

        for user in users:
            # 1. Fetch all attendances for the range
            attendances = Attendance.objects.filter(
                user=user, 
                date__range=[start_date, end_date]
            ).prefetch_related('work_sessions')

            present_days = 0
            total_regular_hours = 0.0
            total_overtime_hours = 0.0
            total_night_hours = 0.0
            
            base_earnings = 0.0
            overtime_earnings = 0.0
            night_diff_earnings = 0.0

            for att in attendances:
                if att.status in [Attendance.STATUS_PRESENT, Attendance.STATUS_HALF_DAY]:
                    present_days += 1

                # Calculate work hours for this attendance record
                policy = get_user_policy(user)
                base_rate = float(policy.base_hourly_rate) if policy else 20.00
                ot_multiplier = float(policy.overtime_rate_multiplier) if policy else 1.50
                night_multiplier = float(policy.night_differential_multiplier) if policy else 1.20
                standard_hours = float(policy.min_working_hours) if policy else 8.00

                # Check if it's a night shift
                s_time, _ = get_user_shift_times(user, policy)
                is_night_shift = False
                if policy and 'night' in policy.name.lower():
                    is_night_shift = True
                elif user.shift and 'night' in user.shift.name.lower():
                    is_night_shift = True
                elif s_time.hour >= 18 or s_time.hour <= 4:
                    is_night_shift = True

                work_hours = att.effective_work_seconds / 3600.0
                if work_hours > 0:
                    reg_hours = min(work_hours, standard_hours)
                    ot_hours = max(0.0, work_hours - standard_hours)

                    total_regular_hours += reg_hours
                    total_overtime_hours += ot_hours

                    reg_pay = reg_hours * base_rate
                    ot_pay = ot_hours * base_rate * ot_multiplier

                    base_earnings += reg_pay
                    overtime_earnings += ot_pay

                    if is_night_shift:
                        total_night_hours += work_hours
                        diff_pay = work_hours * base_rate * (night_multiplier - 1.0)
                        night_diff_earnings += diff_pay

            # 2. Approved Paid Leaves (Assuming all approved leaves are paid for simple calculation)
            approved_leaves = LeaveRequest.objects.filter(
                employee=user,
                status=LeaveRequest.STATUS_APPROVED,
                from_date__lte=end_date,
                to_date__gte=start_date
            )
            leave_days = sum(l.duration_days for l in approved_leaves)

            # 3. Approved Expenses for Reimbursement
            approved_expenses = Expense.objects.filter(
                user=user,
                status=Expense.STATUS_APPROVED,
                created_at__date__range=[start_date, end_date]
            ).aggregate(amount=Sum('amount'))['amount'] or 0.0

            payroll_data.append({
                'employee_id': str(user.id),
                'email': user.email,
                'name': user.full_name,
                'department': user.department.name if user.department else 'N/A',
                'role': user.role,
                'payable_days': present_days + leave_days,
                'present_days': present_days,
                'paid_leave_days': leave_days,
                'regular_hours': round(total_regular_hours, 2),
                'overtime_hours': round(total_overtime_hours, 2),
                'night_hours': round(total_night_hours, 2),
                'base_earnings': round(base_earnings, 2),
                'overtime_earnings': round(overtime_earnings, 2),
                'night_differential_earnings': round(night_diff_earnings, 2),
                'reimbursable_expenses': float(approved_expenses),
                'total_earnings': round(base_earnings + overtime_earnings + night_diff_earnings + float(approved_expenses), 2)
            })

        return payroll_data

