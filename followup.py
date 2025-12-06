import asyncio
from misskey_api import MisskeyAPI
from logic import find_images_without_alt, build_auto_description_text
from ollama import download_image_bytes, generate_image_description

async def schedule_followup(note_id, user_id, followers):
    await asyncio.sleep(300)  # Wait for 5 minutes
    async with MisskeyAPI() as api:
        note = await api.get_note(note_id)
        if not note or user_id not in followers:
            return
        images_without_alt = find_images_without_alt(note)
        if not images_without_alt:
            return
        descriptions = []
        for img in images_without_alt:
            image_bytes = await download_image_bytes(img["url"])
            description = await generate_image_description(image_bytes)
            descriptions.append(description)
        if descriptions:
            text = build_auto_description_text(descriptions)
            await api.post_reply(note_id, text)