import aiohttp
from config import config

class MisskeyAPI:
    def __init__(self):
        self.base_url = config.MISSKEY_INSTANCE
        self.token = config.MISSKEY_TOKEN
        self.session = None

    async def __aenter__(self):
        self.session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.session.close()

    async def _post(self, endpoint, data):
        url = f"{self.base_url}{endpoint}"
        data["i"] = self.token
        async with self.session.post(url, json=data) as response:
            return await response.json()

    async def get_bot_user_id(self):
        data = {}
        response = await self._post("/api/i", data)
        return response.get("id")

    async def get_followers(self):
        data = {}
        response = await self._post("/api/users/followers", data)
        return [user["id"] for user in response]

    async def get_user_notes(self, user_id, since_timestamp=None):
        data = {"userId": user_id}
        if since_timestamp:
            data["sinceId"] = since_timestamp
        response = await self._post("/api/users/notes", data)
        return response

    async def get_note(self, note_id):
        data = {"noteId": note_id}
        response = await self._post("/api/notes/show", data)
        return response

    async def post_reply(self, note_id, text):
        data = {"replyId": note_id, "text": text}
        response = await self._post("/api/notes/create", data)
        return response