from core.models import AttendancePolicy
from core.services import get_user_policy
from django.contrib.auth import get_user_model
User = get_user_model()

print("=== GLOBAL POLICIES (ordered by -updated_at) ===")
for p in AttendancePolicy.objects.filter(is_active=True, department__isnull=True).order_by('-updated_at'):
    print(f"  id={p.id} name={p.name} idle={p.idle_threshold_minutes}min updated={p.updated_at}")

print()
print("=== POLICY RETURNED NOW ===")
for u in User.objects.filter(is_active=True, role='employee'):
    pol = get_user_policy(u)
    print(f"  {u.email} -> idle={pol.idle_threshold_minutes}min (policy: {pol.name})")
