import asyncio
from config import config
from misskey_api import MisskeyAPI
from logic import find_images_without_alt, is_valid_note, build_reminder_text
from followup import schedule_followup

async def main():
    async with MisskeyAPI() as api:
        bot_user_id = await api.get_bot_user_id()
        followers = set(await api.get_followers())
        processed_note_ids = set()

        while True:
            for user_id in followers:
                notes = await api.get_user_notes(user_id)
                for note in notes:
                    if note["id"] in processed_note_ids:
                        continue
                    if not is_valid_note(note):
                        continue
                    images_without_alt = find_images_without_alt(note)
                    if images_without_alt:
                        await api.post_reply(note["id"], build_reminder_text())
                        processed_note_ids.add(note["id"])
                        asyncio.create_task(schedule_followup(note["id"], user_id, followers))
            await asyncio.sleep(config.CHECK_INTERVAL_SECONDS)

if __name__ == "__main__":
    asyncio.run(main())