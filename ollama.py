import aiohttp
import base64
from config import config

async def download_image_bytes(url):
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            return await response.read()

async def generate_image_description(image_bytes):
    base64_image = base64.b64encode(image_bytes).decode("utf-8")
    prompt = "Describe this image in 1-2 short factual sentences in German. Do not use emojis or speculate."
    data = {
        "model": config.OLLAMA_MODEL,
        "prompt": prompt,
        "images": [base64_image]
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(config.OLLAMA_URL, json=data) as response:
            result = await response.json()
            return result.get("response", "")