def find_images_without_alt(note):
    images = note.get("files", [])
    return [img for img in images if not img.get("name") and img.get("type") == "image"]

def is_valid_note(note):
    if note.get("renote") or note.get("reply"):
        return False
    if note.get("visibility") != "public":
        return False
    if not note.get("files"):
        return False
    return True

def build_reminder_text():
    return "Freundliche Erinnerung: Bitte füge Beschreibungen (Alt-Text) zu deinen Bildern hinzu, um Barrierefreiheit zu verbessern."

def build_auto_description_text(descriptions):
    return "Automatisch generierte Bildbeschreibungen:\n" + "\n".join(descriptions)