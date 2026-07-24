(function(){
  const canvas = document.getElementById('glcanvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
 
  if (!gl) {
    // No WebGL: leave the CSS fallback background in place.
    canvas.style.display = 'none';
    return;
  }
 
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 
  const vertexSrc = `
    attribute vec2 aPos;
    void main(){
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;
 
  const fragmentSrc = `
    precision highp float;
 
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uColorLevels;
    uniform float uPixelSize;
 
    #define PI 3.14159265359
 
    const float PLANET_R   = 1.0;
    const float ATMOS_R    = 1.16;
    const float RAYLEIGH_H = 0.05;
    const float MIE_H      = 0.014;
 
    // ---------- hashing / noise ----------
    float hash21(vec2 p){
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
 
    float hash13(vec3 p3){
      p3 = fract(p3 * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
 
    float noise(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      float a = hash21(i);
      float b = hash21(i + vec2(1.0, 0.0));
      float c = hash21(i + vec2(0.0, 1.0));
      float d = hash21(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
    }
 
    float fbm(vec2 p){
      float v = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 5; i++){
        v += amp * noise(p);
        p *= 2.02;
        amp *= 0.5;
      }
      return v;
    }
 
    // ---------- ray / sphere ----------
    vec2 raySphere(vec3 ro, vec3 rd, vec3 ce, float ra){
      vec3 oc = ro - ce;
      float b = dot(oc, rd);
      float c = dot(oc, oc) - ra * ra;
      float h = b * b - c;
      if (h < 0.0) return vec2(-1.0);
      h = sqrt(h);
      return vec2(-b - h, -b + h);
    }
 
    // ---------- starfield ----------
    vec3 starField(vec3 rd){
      vec3 col = vec3(0.006, 0.008, 0.017);
      for (int i = 0; i < 3; i++){
        float density = 16.0 + float(i) * 14.0;
        vec3 p = rd * density;
        vec3 idv = floor(p);
        float h = hash13(idv + float(i) * 17.0);
        if (h > 0.985){
          vec3 fpar = fract(p) - 0.5;
          float d = length(fpar);
          float twinkle = 0.6 + 0.4 * sin(uTime * 2.0 + h * 80.0);
          float star = smoothstep(0.12, 0.0, d) * twinkle;
          float b = fract(h * 91.7);
          vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.86, 0.72), b);
          col += tint * star * (1.0 / float(i + 1));
        }
      }
      return col;
    }
 
    // ---------- planet surface shading ----------
    vec3 shadePlanet(vec3 p, vec3 rd, vec3 sunDir){
      vec3 n = normalize(p);
      float ndl = dot(n, sunDir);
      float dayFactor = smoothstep(-0.15, 0.25, ndl);
 
      float terrain = fbm(n.xz * 2.4 + n.y * 1.6);
      vec3 ocean = vec3(0.03, 0.11, 0.27);
      vec3 land  = vec3(0.09, 0.28, 0.17);
      vec3 sand  = vec3(0.42, 0.36, 0.21);
 
      vec3 base = mix(ocean, land, smoothstep(0.42, 0.56, terrain));
      base = mix(base, sand, smoothstep(0.50, 0.53, terrain) * (1.0 - smoothstep(0.53, 0.58, terrain)));
 
      float polar = smoothstep(0.74, 0.87, abs(n.y));
      base = mix(base, vec3(0.86, 0.88, 0.93), polar);
 
      float cloud = fbm(n.xz * 3.1 + n.y * 2.1 + vec2(uTime * 0.012, 0.0));
      float cloudMask = smoothstep(0.6, 0.74, cloud);
      base = mix(base, vec3(0.94), cloudMask * 0.65);
 
      float cityNoise = fbm(n.xz * 7.0 + n.y * 5.0);
      float lights = smoothstep(0.62, 0.75, cityNoise) * (1.0 - polar) * (1.0 - dayFactor);
      vec3 nightLights = vec3(1.0, 0.82, 0.42) * lights * 0.4;
 
      vec3 color = base * mix(0.035, 1.0, dayFactor) + nightLights;
 
      float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
      color += vec3(0.35, 0.55, 0.95) * rim * 0.18 * dayFactor;
 
      return color;
    }
 
    // ---------- atmospheric scattering ----------
    vec3 computeScattering(vec3 ro, vec3 rd, float tmin, float tmax, vec3 sunDir, out vec3 transmittance){
      const int STEPS = 10;
      const int LIGHT_STEPS = 3;
 
      float segLen = max(tmax - tmin, 0.0);
      float stepSize = segLen / float(STEPS);
 
      vec3 betaR = vec3(0.55, 1.15, 2.5);
      float betaM = 0.55;
      float g = 0.76;
      float gg = g * g;
 
      float mu = dot(rd, sunDir);
      float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
      float phaseM = 3.0 * (1.0 - gg) / (2.0 * (2.0 + gg)) * (1.0 + mu * mu) / pow(1.0 + gg - 2.0 * g * mu, 1.5);
 
      float odR = 0.0;
      float odM = 0.0;
      vec3 sumR = vec3(0.0);
      vec3 sumM = vec3(0.0);
 
      for (int i = 0; i < STEPS; i++){
        float tc = tmin + (float(i) + 0.5) * stepSize;
        vec3 p = ro + rd * tc;
        float h = length(p) - PLANET_R;
        float dR = exp(-max(h, 0.0) / RAYLEIGH_H);
        float dM = exp(-max(h, 0.0) / MIE_H);
        odR += dR * stepSize;
        odM += dM * stepSize;
 
        float lodR = 0.0;
        float lodM = 0.0;
        vec2 lPlanet = raySphere(p, sunDir, vec3(0.0), PLANET_R);
 
        if (lPlanet.x > 0.0){
          lodR = 1000.0;
          lodM = 1000.0;
        } else {
          vec2 lHit = raySphere(p, sunDir, vec3(0.0), ATMOS_R);
          if (lHit.y > 0.0){
            float lStepSize = lHit.y / float(LIGHT_STEPS);
            for (int j = 0; j < LIGHT_STEPS; j++){
              float lt = (float(j) + 0.5) * lStepSize;
              vec3 lp = p + sunDir * lt;
              float lh = length(lp) - PLANET_R;
              lodR += exp(-max(lh, 0.0) / RAYLEIGH_H) * lStepSize;
              lodM += exp(-max(lh, 0.0) / MIE_H) * lStepSize;
            }
          } else {
            lodR = 1000.0;
            lodM = 1000.0;
          }
        }
 
        vec3 tau = betaR * (odR + lodR) + vec3(betaM * 1.11) * (odM + lodM);
        vec3 atten = exp(-tau);
        sumR += dR * atten * stepSize;
        sumM += dM * atten * stepSize;
      }
 
      transmittance = exp(-(betaR * odR + vec3(betaM * 1.11) * odM));
      vec3 sunIntensity = vec3(9.0);
      return (sumR * betaR * phaseR + sumM * betaM * phaseM) * sunIntensity;
    }
 
    vec3 ACESFilm(vec3 x){
      float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }
 
    // ---------- ordered (Bayer 4x4) dithering + color quantization ----------
    float bayerValue(int x, int y){
      int index = x + y * 4;
      if (index == 0) return 0.0;
      if (index == 1) return 8.0;
      if (index == 2) return 2.0;
      if (index == 3) return 10.0;
      if (index == 4) return 12.0;
      if (index == 5) return 4.0;
      if (index == 6) return 14.0;
      if (index == 7) return 6.0;
      if (index == 8) return 3.0;
      if (index == 9) return 11.0;
      if (index == 10) return 1.0;
      if (index == 11) return 9.0;
      if (index == 12) return 15.0;
      if (index == 13) return 7.0;
      if (index == 14) return 13.0;
      return 5.0;
    }
 
    vec3 ditherColor(vec3 color, vec2 fragCoord, float colorNum){
      int x = int(mod(fragCoord.x, 4.0));
      int y = int(mod(fragCoord.y, 4.0));
      float bv = bayerValue(x, y) / 16.0 - 0.5;
 
      color += bv * (1.0 / colorNum);
      color.r = floor(color.r * (colorNum - 1.0) + 0.5) / max(colorNum - 1.0, 1.0);
      color.g = floor(color.g * (colorNum - 1.0) + 0.5) / max(colorNum - 1.0, 1.0);
      color.b = floor(color.b * (colorNum - 1.0) + 0.5) / max(colorNum - 1.0, 1.0);
 
      return clamp(color, 0.0, 1.0);
    }
 
    void main(){
      // snap to a pixel grid first so the whole raymarched scene reads as chunky/retro
      vec2 pfrag = floor(gl_FragCoord.xy / uPixelSize) * uPixelSize + uPixelSize * 0.5;
      vec2 uv = (pfrag - 0.5 * uResolution.xy) / uResolution.y;
 
      float camAngle = uTime * 0.025;
      vec3 camPos = vec3(sin(camAngle) * 2.6, 0.18 + 0.05 * sin(uTime * 0.05), cos(camAngle) * 2.6);
      vec3 forward = normalize(-camPos);
      vec3 right = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
      vec3 up = cross(right, forward);
      float tanFov = tan(radians(30.0));
 
      vec3 ro = camPos;
      vec3 rd = normalize(forward + uv.x * right * tanFov + uv.y * up * tanFov);
 
      vec3 sunDir = normalize(vec3(0.55, 0.30, -0.32));
 
      vec3 starColor = starField(rd);
 
      float sunMu = dot(rd, sunDir);
      vec3 sunGlow = vec3(1.0, 0.92, 0.75) * (pow(max(sunMu, 0.0), 1400.0) * 6.0 + pow(max(sunMu, 0.0), 12.0) * 0.25);
      vec3 bg = starColor + sunGlow;
 
      vec2 atmosHit = raySphere(ro, rd, vec3(0.0), ATMOS_R);
      vec2 planetHitT = raySphere(ro, rd, vec3(0.0), PLANET_R);
 
      vec3 color;
 
      if (atmosHit.y < 0.0){
        color = bg;
      } else {
        float tNear = max(atmosHit.x, 0.0);
        float tFar = atmosHit.y;
        bool hitPlanet = planetHitT.x > 0.0;
        if (hitPlanet) tFar = min(tFar, planetHitT.x);
 
        vec3 transmittance;
        vec3 scatter = computeScattering(ro, rd, tNear, tFar, sunDir, transmittance);
 
        vec3 backdrop = hitPlanet ? shadePlanet(ro + rd * planetHitT.x, rd, sunDir) : bg;
        color = backdrop * transmittance + scatter;
      }
 
      color = ACESFilm(color * 1.25);
      color = pow(color, vec3(0.4545));
 
      color = ditherColor(color, pfrag, uColorLevels);
 
      gl_FragColor = vec4(color, 1.0);
    }
  `;
 
  function compile(type, src){
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)){
      console.error(gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }
 
  const vs = compile(gl.VERTEX_SHADER, vertexSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSrc);
 
  if (!vs || !fs) { canvas.style.display = 'none'; return; }
 
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
 
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)){
    console.error(gl.getProgramInfoLog(program));
    canvas.style.display = 'none';
    return;
  }
 
  gl.useProgram(program);
 
  const quad = new Float32Array([-1, -1, 3, -1, -1, 3]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
 
  const aPos = gl.getAttribLocation(program, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
 
  const uResolution = gl.getUniformLocation(program, 'uResolution');
  const uTime = gl.getUniformLocation(program, 'uTime');
  const uColorLevels = gl.getUniformLocation(program, 'uColorLevels');
  const uPixelSize = gl.getUniformLocation(program, 'uPixelSize');
 
  function resize(){
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h){
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
 
  let startTime = performance.now();
 
  function render(now){
    resize();
    const t = reduceMotion ? 0.0 : (now - startTime) * 0.001;
 
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uColorLevels, 6.0);
    gl.uniform1f(uPixelSize, Math.max(1.0, Math.min(window.devicePixelRatio || 1, 1.5) * 2.0));
 
    gl.drawArrays(gl.TRIANGLES, 0, 3);
 
    if (!reduceMotion) requestAnimationFrame(render);
  }
 
  requestAnimationFrame(render);
})();