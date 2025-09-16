export async function enableWindFlow(L, map){
  // Wenn du eigene /wind/current.json erzeugst, nimm die:
  let resp = await fetch('/wind/current.json', {cache:'no-store'});
  if(!resp.ok) resp = await fetch('/wind/wind.json', {cache:'no-store'});
  const data = await resp.json();

  map.createPane('windPane'); map.getPane('windPane').style.zIndex=480;
  const isMobile=/iphone|ipad|android|mobile/i.test(navigator.userAgent);
  const layer = L.velocityLayer({
    data, pane:'windPane',
    velocityScale:0.008, maxVelocity:25,
    lineWidth: isMobile?0.8:1.0,
    particleMultiplier: isMobile?1/350:1/200,
    displayValues:true,
    displayOptions:{ position:'bottomleft', emptyString:'Keine Winddaten', velocityType:'Wind', speedUnit:'m/s', directionString:'Richtung' }
  });
  layer.addTo(map);
}
