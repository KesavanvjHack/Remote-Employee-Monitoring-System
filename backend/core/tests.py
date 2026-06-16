from django.test import TestCase
from datetime import date, time
from .models import User, Attendance, AttendancePolicy
from .services import PayrollPrepService

class PayrollCalculationTestCase(TestCase):
    def setUp(self):
        # Create user
        self.user = User.objects.create_user(
            email='testemployee@example.com',
            password='testpassword123',
            first_name='Test',
            last_name='Employee',
            role=User.EMPLOYEE
        )

        # Create policies
        self.morning_policy = AttendancePolicy.objects.create(
            name='Morning Shift',
            min_working_hours=8.0,
            present_hours=8.0,
            half_day_hours=4.0,
            idle_threshold_minutes=15,
            shift_start_time=time(9, 30),
            shift_end_time=time(17, 30),
            session_timeout_hours=24,
            base_hourly_rate=20.00,
            overtime_rate_multiplier=1.50,
            night_differential_multiplier=1.20
        )

        self.night_policy = AttendancePolicy.objects.create(
            name='Night Shift',
            min_working_hours=8.0,
            present_hours=8.0,
            half_day_hours=4.0,
            idle_threshold_minutes=15,
            shift_start_time=time(19, 30),
            shift_end_time=time(3, 30),
            session_timeout_hours=24,
            base_hourly_rate=20.00,
            overtime_rate_multiplier=1.50,
            night_differential_multiplier=1.20
        )

    def test_morning_shift_payroll_calculation(self):
        # Assign morning policy to the department/user
        # For simplicity, get_user_policy falls back to the matching/active policy.
        # Let's ensure the user gets this policy. We'll set the user's shift or name structure.
        # Wait, get_user_policy(user) resolves policy by name or department.
        # Let's check get_user_policy in services.py to see how it works.
        # For this test, let's keep only one active policy or name matching.
        # Let's check how get_user_policy behaves. Let's delete the other policies or make them inactive/active.
        
        # Let's set morning_policy as active and others inactive
        self.morning_policy.is_active = True
        self.morning_policy.save()
        self.night_policy.is_active = False
        self.night_policy.save()

        # Let's add an Attendance for this employee: 10 hours of work on June 15th
        Attendance.objects.create(
            user=self.user,
            date=date(2026, 6, 15),
            status=Attendance.STATUS_PRESENT,
            total_work_seconds=10 * 3600,
            total_break_seconds=0,
            total_idle_seconds=0
        )

        payroll = PayrollPrepService.prepare_monthly_payroll(6, 2026)
        
        self.assertEqual(len(payroll), 1)
        record = payroll[0]
        self.assertEqual(record['email'], 'testemployee@example.com')
        self.assertEqual(record['regular_hours'], 8.0)
        self.assertEqual(record['overtime_hours'], 2.0)
        self.assertEqual(record['night_hours'], 0.0)
        self.assertEqual(record['base_earnings'], 160.0)      # 8 * 20.00
        self.assertEqual(record['overtime_earnings'], 60.0)   # 2 * 20.00 * 1.5
        self.assertEqual(record['night_differential_earnings'], 0.0)
        self.assertEqual(record['total_earnings'], 220.0)      # 160 + 60

    def test_night_shift_payroll_calculation(self):
        # Let's set night_policy as active and others inactive
        self.morning_policy.is_active = False
        self.morning_policy.save()
        self.night_policy.is_active = True
        self.night_policy.save()

        # Create user shift name or night policy
        # Let's add an Attendance for this employee: 10 hours of work on June 16th
        # Since night_policy matches "Night Shift" name, the calculation will calculate it as a night shift.
        Attendance.objects.create(
            user=self.user,
            date=date(2026, 6, 16),
            status=Attendance.STATUS_PRESENT,
            total_work_seconds=10 * 3600,
            total_break_seconds=0,
            total_idle_seconds=0
        )

        payroll = PayrollPrepService.prepare_monthly_payroll(6, 2026)
        
        self.assertEqual(len(payroll), 1)
        record = payroll[0]
        self.assertEqual(record['email'], 'testemployee@example.com')
        self.assertEqual(record['regular_hours'], 8.0)
        self.assertEqual(record['overtime_hours'], 2.0)
        self.assertEqual(record['night_hours'], 10.0)
        self.assertEqual(record['base_earnings'], 160.0)
        self.assertEqual(record['overtime_earnings'], 60.0)
        # Night differential: 10.0 hours * 20.00 base_rate * (1.20 - 1.0) = 10 * 20 * 0.2 = 40.00
        self.assertEqual(record['night_differential_earnings'], 40.0)
        self.assertEqual(record['total_earnings'], 260.0)      # 160 + 60 + 40
