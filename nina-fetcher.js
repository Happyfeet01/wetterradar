#!/usr/bin/env node
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const API_URL = process.env.NINA_API_URL || 'https://nina.api.bund.dev/api31/warnings/geojson';
const OUTPUT_DIR = path.join(process.cwd(), 'warnings');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'nina.json');

async function fetchWarnings(){
  const res = await fetch(API_URL, { cache: 'no-store' });
  if(!res.ok){
    throw new Error(`Request failed with status ${res.status}`);
  }
  const data = await res.json();
  if(!Array.isArray(data)){
    throw new Error('Unexpected response format – expected an array');
  }
  return data;
}

function isValidGeometry(geom){
  if(!geom || typeof geom !== 'object') return false;
  if(typeof geom.type !== 'string') return false;
  if(!('coordinates' in geom)) return false;
  return Array.isArray(geom.coordinates);
}

function pickFirst(...candidates){
  for(const cand of candidates){
    if(cand === undefined || cand === null) continue;
    if(typeof cand === 'string' && cand.trim() !== '') return cand;
    if(typeof cand === 'number' && Number.isFinite(cand)) return cand;
    if(Array.isArray(cand) && cand.length) return cand;
    if(typeof cand === 'object' && Object.keys(cand).length) return cand;
  }
  return undefined;
}

function normalizeAreas(value){
  if(Array.isArray(value)){
    return value.filter(v => typeof v === 'string' && v.trim() !== '');
  }
  if(typeof value === 'string' && value.trim() !== ''){
    return [value.trim()];
  }
  return [];
}

function toFeature(entry){
  const geometry = pickFirst(entry?.geometry, entry?.payload?.geom, entry?.payload?.geometry, entry?.payload?.data?.geom, entry?.properties?.geometry);
  if(!isValidGeometry(geometry)) return null;

  const props = pickFirst(entry?.payload?.data, entry?.payload, entry?.properties, entry) || {};
  const properties = {
    severity: String(pickFirst(props?.severity, props?.awarenessLevel, props?.warnlevel, props?.priority, 'unknown')),
    title: String(pickFirst(props?.headline, props?.title, props?.event, props?.description, 'Warnung')),
    category: String(pickFirst(props?.category, props?.type, props?.status, props?.group, 'general')),
    areas: normalizeAreas(pickFirst(props?.areas, props?.areaNames, props?.area, props?.regions)),
    sent: pickFirst(props?.sent, props?.onset, props?.start, props?.effective) || null,
    expires: pickFirst(props?.expires, props?.expiry, props?.end) || null,
  };

  const feature = {
    type: 'Feature',
    id: String(pickFirst(entry?.id, props?.id, props?.identifier, props?.hash, randomUUID())),
    properties,
    geometry,
  };
  return feature;
}

async function writeAtomic(filePath, content){
  const outDir = path.dirname(filePath);
  await fs.mkdir(outDir, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(outDir, '.tmp-nina-'));
  const tmpFile = path.join(tmpDir, 'nina.json');
  await fs.writeFile(tmpFile, content, 'utf8');
  await fs.rename(tmpFile, filePath);
}

async function main(){
  try{
    const warnings = await fetchWarnings();
    const features = warnings
      .map(toFeature)
      .filter(Boolean);

    const payload = {
      type: 'FeatureCollection',
      meta: {
        source: 'NINA / BBK',
        generated: new Date().toISOString(),
      },
      features,
    };

    await writeAtomic(OUTPUT_FILE, JSON.stringify(payload, null, 2));
    console.log(`Wrote ${features.length} warnings to ${OUTPUT_FILE}`);
  }catch(err){
    console.error('[nina-fetcher] Fehler:', err?.message || err);
    if(err?.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

main();
