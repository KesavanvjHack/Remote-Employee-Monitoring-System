import re

with open('d:/REMS/REMS_Finalized/backend/core/views.py', 'r', encoding='utf-8') as f:
    content = f.read()

# Fix UserViewSet queryset
content = content.replace(
    "User.objects.select_related('department', 'manager').all()",
    "User.objects.select_related('department', 'manager', 'shift').all()"
)
content = content.replace(
    "select_related('department', 'manager')",
    "select_related('department', 'manager', 'shift')"
)

# Fix AttendanceViewSet queryset
content = content.replace(
    "Attendance.objects.select_related('user', 'reviewed_by')",
    "Attendance.objects.select_related('user', 'reviewed_by', 'user__department', 'user__manager', 'user__shift')"
)

# Fix ReportViewSet queryset
content = content.replace(
    "Attendance.objects.select_related('user', 'user__department').all()",
    "Attendance.objects.select_related('user', 'user__department', 'user__manager', 'user__shift', 'reviewed_by').all()"
)

# Fix TeamStatusView
content = content.replace(
    "select_related('department')",
    "select_related('department', 'manager', 'shift')"
)

with open('d:/REMS/REMS_Finalized/backend/core/views.py', 'w', encoding='utf-8') as f:
    f.write(content)
print("Done")
