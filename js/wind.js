import { OPENMETEO_TZ } from './config.js';

let windMarker=null, windTimer=null, debounce=null;

export function bindWind(L, map, ui){
  ui.chkWind.onchange=()=> ui.chkWind.checked ? start() : stop();
  ui.selWindUnit.onchange = ()=> { if (windMarker) refresh(map.getCenter()); };
  map.on('moveend', ()=>{ if(!ui.chkWind.checked) return;
    clearTimeout(debounce); debounce=setTimeout(()=>refresh(map.getCenter()), 400);
  });

  function start(){ refresh(map.getCenter()); schedule(); }
  function stop(){ clearInterval(windTimer); windTimer=null; if(windMarker){map.removeLayer(windMarker); windMarker=null;} }
  function schedule(){ clearInterval(windTimer); windTimer=setInterval(()=>refresh(map.getCenter()), 30*60*1000); }

  async function refresh(center){
    try{
      const lat=center.lat.toFixed(3), lon=center.lng.toFixed(3);
      const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m&timezone=${encodeURIComponent(OPENMETEO_TZ)}`;
      const data=await fetch(url,{cache:'no-store'}).then(r=>r.json());
      const sp=data?.hourly?.wind_speed_10m?.[0], dir=data?.hourly?.wind_direction_10m?.[0];
      if(sp==null||dir==null) return;
      const ms=Number(sp), kmh=ms*3.6;
      const unit=ui.selWindUnit.value;
      const speed= unit==='kmh' ? `${kmh.toFixed(1)} km/h` : `${ms.toFixed(1)} m/s`;
      const size=36, svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" style="transform: rotate(${dir}deg);"><path d="M12 2l4 8h-3v8h-2V10H8l4-8z" fill="#223" opacity="0.9"/><circle cx="12" cy="12" r="11" fill="none" stroke="#223" stroke-opacity="0.2"/></svg>`;
      const icon=L.divIcon({html:svg,className:'wind-arrow',iconSize:[size,size],iconAnchor:[size/2,size/2]});
      if(windMarker) map.removeLayer(windMarker);
      windMarker=L.marker(center,{icon}).bindPopup(`Wind (10 m): ${speed}<br>Richtung: ${Math.round(dir)}°`).addTo(map);
    }catch(e){ console.warn('Winddaten fehlgeschlagen:', e); }
  }
}
