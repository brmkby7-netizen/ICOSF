// Parallax Window Tool - Custom node body for M_ParallaxWindow.
//
// This file is pasted into the material's Custom node by "Build / Update Materials".
// Edit it as text, then press the button again. Input names must match the list in
// ParallaxWindowMaterialBuilder.cpp (PW inputs). Returns Emissive; writes BaseColorOut.
//
// Conventions (set by the Analyze step):
//   UV            0-1 per window, upright, bottom-left origin (v grows upwards)
//   WindowSize    window width / height in cm
//   WindowData.x        window random ID in [0,1)     WindowData.y  floor index
// The window frame is rebuilt here from the vertex normal and the mesh's up axis, so
// the result does not depend on mesh tangents.

struct PWHash
{
	uint Pcg(uint V)
	{
		uint S = V * 747796405u + 2891336453u;
		uint W = ((S >> ((S >> 28u) + 4u)) ^ S) * 277803737u;
		return (W >> 22u) ^ W;
	}
	float Rand(uint A, uint B, uint K)
	{
		return float(Pcg(A ^ Pcg(B ^ Pcg(K)))) * (1.0 / 4294967296.0);
	}
};
PWHash PWRand;

// ---------------------------------------------------------------- Seeds and IDs
// Building seed = Custom Primitive Data [0] (+ per-instance custom data [0] for ISMs).
// Unset (0) falls back to a hash of the object position so copies still differ.
float SeedF = SeedCPD + SeedInstance;
uint SeedU = asuint(SeedF);
if (SeedF == 0.0)
{
	SeedU = PWRand.Pcg(asuint(ObjPosFrac.x) ^ PWRand.Pcg(asuint(ObjPosFrac.y) ^ PWRand.Pcg(asuint(ObjPosFrac.z) ^ asuint(InstanceRandom))));
}
// ---------------------------------------------------------------- Room tiling
// A window wider than Max Room Width (or taller than Max Room Height) is split into several rooms,
// each with its own texture, light and blinds. 0 = off. WindowSize is the window's size in cm (from Analyze).
float2 Tiles = float2(1.0, 1.0);
if (MaxRoomWidth > 1.0 && WindowSize.x > 0.0)  { Tiles.x = max(1.0, ceil(WindowSize.x / MaxRoomWidth - 0.001)); }
if (MaxRoomHeight > 1.0 && WindowSize.y > 0.0) { Tiles.y = max(1.0, ceil(WindowSize.y / MaxRoomHeight - 0.001)); }
float2 TiledUV = UV * Tiles;
float2 Cell = clamp(floor(TiledUV), 0.0, Tiles - 1.0);
float2 CellUV = TiledUV - Cell;

uint IdU = uint(WindowData.x * 16777216.0 + 0.5);
IdU ^= PWRand.Pcg(uint(Cell.x) * 73856093u ^ uint(Cell.y) * 19349663u);
uint FloorU = uint(max(WindowData.y, 0.0) + 0.5) * 2654435761u + 977u;

// ---------------------------------------------------------------- Global controls (Material Parameter Collection)
float Night = saturate(lerp(DayNight, GlobalDayNight, UseGlobalDayNight));
float LitPct = saturate(lerp(LitPercent, GlobalLitPercent, UseGlobalLighting));
float WarmPct = saturate(lerp(WarmRatio, GlobalWarmRatio, UseGlobalLighting));

// ---------------------------------------------------------------- Random lighting with floor patterns
// Floor Blend: chance that a window follows its floor's random value instead of its own,
// so 0 = every window independent, 1 = whole floors lit or dark.
float FollowFloor = PWRand.Rand(IdU, SeedU, 3u) < FloorBlend ? 1.0 : 0.0;
float LitRoll = lerp(PWRand.Rand(IdU, SeedU, 1u), PWRand.Rand(FloorU, SeedU, 2u), FollowFloor);
float IsLit = LitRoll < LitPct ? 1.0 : 0.0;
float WarmRoll = lerp(PWRand.Rand(IdU, SeedU, 4u), PWRand.Rand(FloorU, SeedU, 5u), FollowFloor);
float3 LightColor = WarmRoll < WarmPct ? WarmColor.rgb : ColdColor.rgb;
float Brightness = lerp(BrightnessMin, BrightnessMax, PWRand.Rand(IdU, SeedU, 6u));
float3 Light = IsLit * LightColor * Brightness * LightIntensity;

// ---------------------------------------------------------------- Window frame and view direction
float3 N = normalize(NormalWS);
float3 Up = UpWS - N * dot(UpWS, N);
Up = dot(Up, Up) > 1e-6 ? normalize(Up) : float3(0, 0, 1);
float3 Rt = cross(N, Up);
float3 V = -CamVec;                                           // camera -> pixel
float3 DirTS = float3(dot(V, Rt), dot(V, Up), dot(V, N));     // z < 0 points into the room
float NdotV = saturate(dot(N, CamVec));

float2 WinUV = saturate(CellUV);
float2 Gx = ddx(TiledUV);
float2 Gy = ddy(TiledUV);

// ---------------------------------------------------------------- Room texture (Texture 2D Array)
uint RoomW, RoomH, RoomCount;
Room.GetDimensions(RoomW, RoomH, RoomCount);
float Slice = float(PWRand.Pcg(IdU ^ PWRand.Pcg(SeedU ^ 0x68E31DA4u)) % max(RoomCount, 1u));

// Distance fallback: past FallbackDistance the parallax is skipped entirely ([branch]),
// leaving one low-mip fetch: the room's average color.
float3 FlatColor = Room.SampleLevel(RoomSampler, float3(0.5, 0.5, Slice), 16.0).rgb;
float Far = saturate((ViewDepth - FallbackDistance) / max(FallbackFade, 1.0));
float3 Interior = FlatColor;

[branch]
if (Far < 1.0)
{
	// 2D interior mapping: the one-point perspective room image is treated as a box behind the glass.
	// Room Depth 0.5 matches images whose back wall spans half the image.
	float FarFrac = clamp(1.0 - RoomDepth, 0.02, 0.98);
	float DepthScale = 1.0 / (1.0 - FarFrac) - 1.0;

	float3 Pos = float3(WinUV * 2.0 - 1.0, -1.0);
	float3 Dir = DirTS;
	Dir.z *= -DepthScale;
	// Avoid inf - inf = NaN when looking exactly head-on.
	Dir.x = abs(Dir.x) < 1e-5 ? 1e-5 : Dir.x;
	Dir.y = abs(Dir.y) < 1e-5 ? 1e-5 : Dir.y;
	float3 InvDir = 1.0 / Dir;
	float3 K = abs(InvDir) - Pos * InvDir;
	float KMin = min(min(K.x, K.y), K.z);
	Pos += KMin * Dir;

	float Interp = Pos.z * 0.5 + 0.5;
	float RealZ = saturate(Interp) / DepthScale + 1.0;
	Interp = 1.0 - (1.0 / RealZ);
	Interp *= DepthScale + 1.0;

	float2 RoomUV = Pos.xy * lerp(1.0, FarFrac, Interp) * 0.5 + 0.5;
	RoomUV.y = 1.0 - RoomUV.y;                                // textures are top-left origin
	float3 RoomColor = Room.SampleGrad(RoomSampler, float3(RoomUV, Slice), Gx, Gy).rgb;

	// Optional foreground layer (storefront shelves / signage), a flat alpha plane just behind the glass.
	if (UseForeground > 0.5)
	{
		uint FgW, FgH, FgCount;
		Foreground.GetDimensions(FgW, FgH, FgCount);
		float FgSlice = float(PWRand.Pcg(IdU ^ PWRand.Pcg(SeedU ^ 0x1B56C4E9u)) % max(FgCount, 1u));
		float2 FgUV = WinUV + DirTS.xy / max(-DirTS.z, 0.05) * ForegroundDepth;
		if (all(FgUV >= 0.0) && all(FgUV <= 1.0))
		{
			float4 Fg = Foreground.SampleGrad(ForegroundSampler, float3(FgUV.x, 1.0 - FgUV.y, FgSlice), Gx, Gy);
			RoomColor = lerp(RoomColor, Fg.rgb, Fg.a);
		}
	}

	Interior = lerp(RoomColor, FlatColor, Far);
}

// ---------------------------------------------------------------- Lighting, day / night
float3 NightInterior = Interior * (Light + UnlitLevel);
float3 DayInteriorColor = Interior * DayInterior;
float3 Emissive = lerp(DayInteriorColor, NightInterior, Night);

// ---------------------------------------------------------------- Random blinds (on the glass plane)
float HasBlinds = PWRand.Rand(IdU, SeedU, 7u) < BlindsAmount ? 1.0 : 0.0;
float BlindBottom = lerp(0.15, 0.95, PWRand.Rand(IdU, SeedU, 8u));
float BlindMask = HasBlinds * step(BlindBottom, WinUV.y);
float Slat = abs(frac(WinUV.y * BlindsSlats) - 0.5) * 2.0;
float3 BlindAlbedo = BlindsColor.rgb * lerp(0.7, 1.0, smoothstep(0.0, 0.6, Slat));
float3 BlindEmissive = lerp(BlindAlbedo * DayInterior * 1.5, BlindAlbedo * (Light * 0.35 + UnlitLevel), Night);
Emissive = lerp(Emissive, BlindEmissive, BlindMask);

// ---------------------------------------------------------------- Glass: Schlick Fresnel reflection on top
float BaseReflect = lerp(DayReflectivity, NightReflectivity, Night);
float Reflect = saturate(BaseReflect + (1.0 - BaseReflect) * pow(1.0 - NdotV, 5.0));
Emissive *= (1.0 - Reflect);

// Metallic is 1 in the graph, so BaseColor is the reflection color (no diffuse on glass).
BaseColorOut = GlassTint.rgb * Reflect;
return Emissive;
