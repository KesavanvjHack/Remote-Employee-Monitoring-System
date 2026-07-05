import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.core.cache import cache

PRESENCE_TTL = 35       # seconds — 3x the 10s heartbeat with safety margin
CHANNELS_TTL = 50       # slightly longer for set bookkeeping


class StatusConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        # Global updates group — every connected user receives all status broadcasts
        self.group_name = 'status_updates'
        self.user_id = None  # Set on first presence heartbeat
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        # PASSIVE AUTOMATION: Trigger policy checks whenever someone connects
        await self.trigger_passive_automation()

    async def trigger_passive_automation(self):
        from .services import AttendanceService
        try:
            await database_sync_to_async(AttendanceService.auto_checkout_all_active_sessions)()
            await database_sync_to_async(AttendanceService.notify_upcoming_shifts)()
        except Exception:
            pass

    async def disconnect(self, close_code):
        # Leave global group
        await self.channel_layer.group_discard(self.group_name, self.channel_name)

        if self.user_id:
            # Leave private user group
            await self.channel_layer.group_discard(f'user_{self.user_id}', self.channel_name)

            # Remove this channel from the active set.
            # Only mark offline if ALL connections for this user are gone.
            is_empty = await self.remove_active_channel(self.user_id, self.channel_name)
            if is_empty:
                import asyncio
                asyncio.create_task(self.delayed_offline_check(self.user_id))

    async def delayed_offline_check(self, user_id):
        import asyncio
        # Wait 6 seconds to allow for page reloads / short network flickers
        await asyncio.sleep(6)
        still_empty = await self.check_channels_empty(user_id)
        if still_empty:
            await self.set_presence_offline(user_id)
            await self.trigger_status_broadcast(user_id)

    @database_sync_to_async
    def check_channels_empty(self, user_id):
        user_id = str(user_id)
        channel_key = f'presence_channels_{user_id}'
        channels = cache.get(channel_key)
        if not isinstance(channels, set):
            channels = set()
        return len(channels) == 0


    async def receive(self, text_data):
        try:
            data = json.loads(text_data)
            m_type = data.get('type')

            if m_type == 'presence':
                user_id = data.get('user_id')
                if user_id:
                    is_first = not self.user_id
                    # Register user_id on first heartbeat and join private group
                    if is_first:
                        self.user_id = str(user_id)
                        await self.channel_layer.group_add(f'user_{self.user_id}', self.channel_name)

                    # Refresh presence TTL and update channel set
                    await self.add_active_channel(self.user_id, self.channel_name)

                    # Broadcast on first heartbeat only to announce online status
                    if is_first:
                        await self.trigger_status_broadcast(self.user_id)

        except Exception:
            pass

    @database_sync_to_async
    def add_active_channel(self, user_id, channel_name):
        """Add this channel to the user's active channel set and refresh presence TTL."""
        user_id = str(user_id)
        channel_key = f'presence_channels_{user_id}'
        presence_key = f'presence_{user_id}'

        channels = cache.get(channel_key)
        if not isinstance(channels, set):
            channels = set()
        channels.add(channel_name)

        # Always write both with fresh TTLs on every heartbeat
        cache.set(channel_key, channels, CHANNELS_TTL)
        cache.set(presence_key, True, PRESENCE_TTL)

    @database_sync_to_async
    def remove_active_channel(self, user_id, channel_name):
        """
        Remove this channel from the user's active channel set.
        Returns True if the set is now empty (user is fully offline).
        """
        user_id = str(user_id)
        channel_key = f'presence_channels_{user_id}'

        channels = cache.get(channel_key)
        if not isinstance(channels, set):
            channels = set()

        channels.discard(channel_name)

        if channels:
            # Other tabs still open — keep presence alive
            cache.set(channel_key, channels, CHANNELS_TTL)
            return False
        else:
            # All connections closed
            cache.delete(channel_key)
            return True

    @database_sync_to_async
    def set_presence_offline(self, user_id):
        """Remove presence key — user is now considered offline."""
        cache.delete(f'presence_{str(user_id)}')

    async def trigger_status_broadcast(self, user_id):
        from .models import User
        from .services import StatusService
        try:
            user = await database_sync_to_async(User.objects.get)(id=user_id)
            await database_sync_to_async(StatusService.broadcast_status_change)(user)
        except Exception:
            pass

    # ── Channel layer message handlers ────────────────────────────────────────

    async def status_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'status_update',
            'user_id': event['user_id'],
            'status': event['status'],
        }))

    async def notification_alert(self, event):
        await self.send(text_data=json.dumps({
            'type': 'notification_alert',
            'notification_id': event['notification_id'],
            'recipient_id': event['recipient_id'],
            'title': event['title'],
            'message': event['message'],
            'notif_type': event['notif_type'],
            'sender_name': event['sender_name']
        }))

    async def policy_update(self, event):
        await self.send(text_data=json.dumps({'type': 'policy_update'}))
