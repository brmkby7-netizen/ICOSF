#include "ParallaxWindowMaterialBuilder.h"
#include "ParallaxTextureLibrary.h"
#include "ParallaxWindowSettings.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetToolsModule.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "Engine/Texture2DArray.h"
#include "EngineUtils.h"
#include "Factories/MaterialFactoryNew.h"
#include "Factories/MaterialInstanceConstantFactoryNew.h"
#include "FileHelpers.h"
#include "IAssetTools.h"
#include "ImageCore.h"
#include "Interfaces/IPluginManager.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Materials/MaterialParameterCollection.h"
#include "Materials/MaterialExpressionCameraVectorWS.h"
#include "Materials/MaterialExpressionCollectionParameter.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionConstant3Vector.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionCustomPrimitiveData.h"
#include "Materials/MaterialExpressionFrac.h"
#include "Materials/MaterialExpressionMultiply.h"
#include "Materials/MaterialExpressionObjectPositionWS.h"
#include "Materials/MaterialExpressionPerInstanceCustomData.h"
#include "Materials/MaterialExpressionPerInstanceRandom.h"
#include "Materials/MaterialExpressionPixelDepth.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionTextureCoordinate.h"
#include "Materials/MaterialExpressionTextureObjectParameter.h"
#include "Materials/MaterialExpressionTransform.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionVertexNormalWS.h"
#include "Misc/FileHelper.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Misc/ScopedSlowTask.h"
#include "Modules/ModuleManager.h"
#include "ScopedTransaction.h"
#include "UObject/Package.h"

#define LOCTEXT_NAMESPACE "ParallaxWindowMaterialBuilder"

DEFINE_LOG_CATEGORY_STATIC(LogParallaxWindowMaterials, Log, All);

namespace ParallaxWindowParams
{
	const FName RoomTextures(TEXT("Room Textures"));
	const FName ForegroundTextures(TEXT("Foreground Textures"));
	const FName RoomDepth(TEXT("Room Depth"));
	const FName LitPercent(TEXT("Lit Percent"));
	const FName WarmRatio(TEXT("Warm Ratio"));
	const FName FloorBlend(TEXT("Floor Blend"));
	const FName BlindsAmount(TEXT("Blinds Amount"));
	const FName UseGlobalLighting(TEXT("Use Global Lighting"));
	const FName UseForeground(TEXT("Use Foreground"));

	const FName CityDayNight(TEXT("DayNight"));
	const FName CityLitPercent(TEXT("LitPercent"));
	const FName CityWarmRatio(TEXT("WarmRatio"));
}

namespace ParallaxWindowBuilderPrivate
{
	static const TCHAR* MasterName = TEXT("M_ParallaxWindow");
	static const TCHAR* CollectionName = TEXT("MPC_ParallaxCity");
	static const TCHAR* DefaultRoomsName = TEXT("T_PW_DefaultRooms_Array");
	static const TCHAR* DefaultForegroundName = TEXT("T_PW_DefaultForeground_Array");
	static const TCHAR* LibraryName = TEXT("DA_ParallaxTextureLibrary");

	static FString ToolFolder()
	{
		FString Folder = GetDefault<UParallaxWindowSettings>()->ToolContentFolder.TrimStartAndEnd();
		if (Folder.IsEmpty())
		{
			Folder = TEXT("/Game/ParallaxWindow");
		}
		Folder.RemoveFromEnd(TEXT("/"));
		return Folder;
	}

	static FString InstanceName(EParallaxWindowClass Class)
	{
		return FString::Printf(TEXT("MI_ParallaxWindow_%s"), ParallaxWindow::GetClassDisplayName(Class));
	}

	template <typename T>
	static T* LoadAssetIfExists(const FString& Folder, const FString& Name)
	{
		const FString PackageName = Folder / Name;
		const FString ObjectPath = PackageName + TEXT(".") + Name;
		if (T* Found = FindObject<T>(nullptr, *ObjectPath))
		{
			return Found;
		}
		if (FPackageName::DoesPackageExist(PackageName))
		{
			return LoadObject<T>(nullptr, *ObjectPath);
		}
		return nullptr;
	}

	template <typename T>
	static T* NewAsset(const FString& Folder, const FString& Name)
	{
		UPackage* Package = CreatePackage(*(Folder / Name));
		T* Asset = NewObject<T>(Package, FName(*Name), RF_Public | RF_Standalone | RF_Transactional);
		FAssetRegistryModule::AssetCreated(Asset);
		Asset->MarkPackageDirty();
		return Asset;
	}

	static IAssetTools& AssetTools()
	{
		return FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
	}

	static void SaveAll(const TArray<UObject*>& Assets)
	{
		TArray<UPackage*> Packages;
		for (UObject* Asset : Assets)
		{
			if (Asset)
			{
				Packages.AddUnique(Asset->GetOutermost());
			}
		}
		if (Packages.Num() > 0)
		{
			UEditorLoadingAndSavingUtils::SavePackages(Packages, /*bOnlyDirty*/ true);
		}
	}

	// ------------------------------------------------------------------ Texture arrays

	/** Write BGRA8 slices into a Texture 2D Array asset (created if missing). All slices are W x H. */
	static UTexture2DArray* WriteTextureArray(const FString& Folder, const FString& Name, int32 W, int32 H,
		const TArray<TArray<FColor>>& Slices, bool bHasAlpha)
	{
		if (Slices.Num() == 0 || W <= 0 || H <= 0)
		{
			return nullptr;
		}

		UTexture2DArray* Texture = LoadAssetIfExists<UTexture2DArray>(Folder, Name);
		if (!Texture)
		{
			Texture = NewAsset<UTexture2DArray>(Folder, Name);
		}
		Texture->Modify();

		const int64 SliceBytes = int64(W) * H * sizeof(FColor);
		TArray64<uint8> Data;
		Data.SetNumUninitialized(SliceBytes * Slices.Num());
		for (int32 Index = 0; Index < Slices.Num(); ++Index)
		{
			check(Slices[Index].Num() == W * H);
			FMemory::Memcpy(Data.GetData() + SliceBytes * Index, Slices[Index].GetData(), SliceBytes);
		}

		Texture->Source.Init(W, H, Slices.Num(), 1, TSF_BGRA8, Data.GetData());
		Texture->SRGB = true;
		Texture->CompressionNoAlpha = !bHasAlpha;
		Texture->CompressionSettings = TC_Default;
		Texture->MipGenSettings = TMGS_FromTextureGroup;
		Texture->LODGroup = TEXTUREGROUP_World;
		Texture->PostEditChange();
		Texture->MarkPackageDirty();
		return Texture;
	}

	/** Procedural one-point perspective room (back wall = middle half), so the material works before real textures exist. */
	static TArray<FColor> MakePlaceholderRoom(int32 Size, int32 Variant)
	{
		struct FPalette { FLinearColor Wall, Floor, Ceiling, Accent, Furniture; };
		static const FPalette Palettes[] =
		{
			{ FLinearColor(0.80f, 0.76f, 0.68f), FLinearColor(0.42f, 0.28f, 0.16f), FLinearColor(0.92f, 0.92f, 0.90f), FLinearColor(0.20f, 0.35f, 0.55f), FLinearColor(0.25f, 0.25f, 0.28f) },
			{ FLinearColor(0.62f, 0.70f, 0.72f), FLinearColor(0.55f, 0.55f, 0.55f), FLinearColor(0.95f, 0.95f, 0.95f), FLinearColor(0.75f, 0.45f, 0.20f), FLinearColor(0.15f, 0.18f, 0.22f) },
			{ FLinearColor(0.88f, 0.86f, 0.82f), FLinearColor(0.30f, 0.22f, 0.15f), FLinearColor(0.85f, 0.83f, 0.80f), FLinearColor(0.55f, 0.15f, 0.15f), FLinearColor(0.60f, 0.52f, 0.42f) },
			{ FLinearColor(0.45f, 0.48f, 0.52f), FLinearColor(0.20f, 0.20f, 0.22f), FLinearColor(0.70f, 0.72f, 0.75f), FLinearColor(0.85f, 0.80f, 0.30f), FLinearColor(0.10f, 0.10f, 0.12f) },
			{ FLinearColor(0.78f, 0.70f, 0.62f), FLinearColor(0.60f, 0.45f, 0.30f), FLinearColor(0.95f, 0.93f, 0.88f), FLinearColor(0.25f, 0.50f, 0.30f), FLinearColor(0.35f, 0.22f, 0.15f) },
			{ FLinearColor(0.92f, 0.92f, 0.94f), FLinearColor(0.70f, 0.70f, 0.72f), FLinearColor(0.98f, 0.98f, 0.98f), FLinearColor(0.15f, 0.15f, 0.18f), FLinearColor(0.40f, 0.42f, 0.48f) },
		};
		const FPalette& P = Palettes[Variant % UE_ARRAY_COUNT(Palettes)];

		TArray<FColor> Pixels;
		Pixels.SetNumUninitialized(Size * Size);
		for (int32 Y = 0; Y < Size; ++Y)
		{
			for (int32 X = 0; X < Size; ++X)
			{
				const float U = (X + 0.5f) / Size * 2.f - 1.f; // -1 left .. 1 right
				const float V = (Y + 0.5f) / Size * 2.f - 1.f; // -1 top  .. 1 bottom
				const float M = FMath::Max(FMath::Abs(U), FMath::Abs(V));
				FLinearColor C;

				if (M <= 0.5f)
				{
					// Back wall with a picture and a sofa.
					C = P.Wall * 0.8f;
					if (FMath::Abs(U + 0.1f) < 0.16f && V > -0.32f && V < -0.08f) { C = P.Accent; }
					if (FMath::Abs(U) < 0.36f && V > 0.22f) { C = P.Furniture * (V > 0.3f ? 1.f : 0.8f); }
				}
				else
				{
					const float T = (M - 0.5f) / 0.5f; // 0 at back wall, 1 at the window
					if (FMath::Abs(U) >= FMath::Abs(V))
					{
						C = P.Wall * FMath::Lerp(0.7f, 0.95f, T);
						// A door on the left wall.
						if (U < 0.f && T > 0.15f && T < 0.4f && V > -0.25f * (1.f + T) && V < M) { C = P.Furniture * 1.4f; }
					}
					else if (V > 0.f)
					{
						// Floor planks converge to the vanishing point.
						const float Plank = FMath::Frac(U / FMath::Max(V, 0.01f) * 3.f);
						C = P.Floor * FMath::Lerp(0.65f, 1.f, T) * (Plank < 0.05f ? 0.75f : 1.f);
					}
					else
					{
						C = P.Ceiling * FMath::Lerp(0.8f, 1.f, T);
						// Ceiling lamp.
						const float LampDist = FVector2f(U / 0.18f, (V + 0.7f) / 0.06f).Size();
						if (LampDist < 1.f) { C = FLinearColor(1.f, 0.97f, 0.9f) * 2.f; }
					}
				}
				Pixels[Y * Size + X] = C.GetClamped().ToFColor(/*bSRGB*/ true);
			}
		}
		return Pixels;
	}

	static UTexture2DArray* GetOrCreateDefaultRooms()
	{
		const FString Folder = ToolFolder() / TEXT("Textures");
		if (UTexture2DArray* Existing = LoadAssetIfExists<UTexture2DArray>(Folder, DefaultRoomsName))
		{
			return Existing;
		}
		TArray<TArray<FColor>> Slices;
		for (int32 Variant = 0; Variant < 6; ++Variant)
		{
			Slices.Add(MakePlaceholderRoom(512, Variant));
		}
		return WriteTextureArray(Folder, DefaultRoomsName, 512, 512, Slices, false);
	}

	static UTexture2DArray* GetOrCreateDefaultForeground()
	{
		const FString Folder = ToolFolder() / TEXT("Textures");
		if (UTexture2DArray* Existing = LoadAssetIfExists<UTexture2DArray>(Folder, DefaultForegroundName))
		{
			return Existing;
		}
		TArray<TArray<FColor>> Slices;
		Slices.AddDefaulted();
		Slices[0].Init(FColor(0, 0, 0, 0), 64 * 64);
		return WriteTextureArray(Folder, DefaultForegroundName, 64, 64, Slices, true);
	}

	/** Read a texture's source, center-crop to the target aspect (never rotate) and resize to W x H. */
	static bool ReadSlice(UTexture2D* Texture, int32 W, int32 H, TArray<FColor>& OutPixels, FString& OutWarning)
	{
		FImage Source;
		if (!Texture || !Texture->Source.IsValid() || !Texture->Source.GetMipImage(Source, 0, 0, 0))
		{
			OutWarning = FString::Printf(TEXT("%s has no source image data; skipped."), Texture ? *Texture->GetName() : TEXT("(null)"));
			return false;
		}

		FImage Bgra;
		Source.CopyTo(Bgra, ERawImageFormat::BGRA8, EGammaSpace::sRGB);

		const double TargetAspect = double(W) / double(H);
		const double SourceAspect = double(Bgra.SizeX) / double(Bgra.SizeY);
		int32 CropW = Bgra.SizeX;
		int32 CropH = Bgra.SizeY;
		if (SourceAspect > TargetAspect)
		{
			CropW = FMath::Max(1, FMath::RoundToInt32(Bgra.SizeY * TargetAspect));
		}
		else
		{
			CropH = FMath::Max(1, FMath::RoundToInt32(Bgra.SizeX / TargetAspect));
		}
		const double Kept = (double(CropW) * CropH) / (double(Bgra.SizeX) * Bgra.SizeY);
		if (Kept < 0.85)
		{
			OutWarning = FString::Printf(TEXT("%s is %dx%d; cropped %.0f%% to fit %dx%d. Use images with the pool's shape."),
				*Texture->GetName(), Bgra.SizeX, Bgra.SizeY, (1.0 - Kept) * 100.0, W, H);
		}

		const int32 OffsetX = (Bgra.SizeX - CropW) / 2;
		const int32 OffsetY = (Bgra.SizeY - CropH) / 2;
		FImage Cropped(CropW, CropH, ERawImageFormat::BGRA8, EGammaSpace::sRGB);
		const FColor* Src = reinterpret_cast<const FColor*>(Bgra.RawData.GetData());
		FColor* Dst = reinterpret_cast<FColor*>(Cropped.RawData.GetData());
		for (int32 Row = 0; Row < CropH; ++Row)
		{
			FMemory::Memcpy(Dst + int64(Row) * CropW, Src + int64(Row + OffsetY) * Bgra.SizeX + OffsetX, CropW * sizeof(FColor));
		}

		FImage Resized;
		Cropped.ResizeTo(Resized, W, H, ERawImageFormat::BGRA8, EGammaSpace::sRGB);
		OutPixels.SetNumUninitialized(W * H);
		FMemory::Memcpy(OutPixels.GetData(), Resized.RawData.GetData(), int64(W) * H * sizeof(FColor));
		return true;
	}

	// ------------------------------------------------------------------ Master material

	struct FPin
	{
		const TCHAR* Input;
		UMaterialExpression* Expression;
		int32 OutputIndex;
	};

	static UMaterial* BuildMaster(UMaterialParameterCollection* Collection, UTexture2DArray* DefaultRooms,
		UTexture2DArray* DefaultForeground, FString& Report)
	{
		using namespace ParallaxWindowParams;

		// HLSL lives in a text file so it can be edited and diffed.
		TSharedPtr<IPlugin> Plugin = IPluginManager::Get().FindPlugin(TEXT("ParallaxWindowTool"));
		const FString ShaderPath = Plugin.IsValid()
			? Plugin->GetBaseDir() / TEXT("Shaders/ParallaxWindowCustomNode.hlsl")
			: FString();
		FString Code;
		if (ShaderPath.IsEmpty() || !FFileHelper::LoadFileToString(Code, *ShaderPath))
		{
			Report += FString::Printf(TEXT("ERROR: could not read %s\n"), *ShaderPath);
			return nullptr;
		}

		const FString Folder = ToolFolder();
		UMaterial* Material = LoadAssetIfExists<UMaterial>(Folder, MasterName);
		if (Material)
		{
			UMaterialEditingLibrary::DeleteAllMaterialExpressions(Material);
		}
		else
		{
			UMaterialFactoryNew* Factory = NewObject<UMaterialFactoryNew>();
			Material = Cast<UMaterial>(AssetTools().CreateAsset(MasterName, Folder, UMaterial::StaticClass(), Factory));
			if (!Material)
			{
				Report += TEXT("ERROR: could not create M_ParallaxWindow\n");
				return nullptr;
			}
		}

		Material->Modify();
		Material->BlendMode = BLEND_Opaque;
		Material->SetShadingModel(MSM_DefaultLit);
		Material->TwoSided = false;
		bool bNeedsRecompile = false;
		Material->SetMaterialUsage(bNeedsRecompile, MATUSAGE_StaticLighting);
		Material->SetMaterialUsage(bNeedsRecompile, MATUSAGE_InstancedStaticMeshes);
		Material->SetMaterialUsage(bNeedsRecompile, MATUSAGE_Nanite);

		int32 RowY = -2000;
		auto Create = [Material, &RowY](UClass* Class, int32 X = -900) -> UMaterialExpression*
		{
			UMaterialExpression* Expression = UMaterialEditingLibrary::CreateMaterialExpression(Material, Class, X, RowY);
			RowY += 80;
			return Expression;
		};
		auto Scalar = [&Create](FName Name, float Default, const TCHAR* Group, float Min, float Max) -> UMaterialExpression*
		{
			UMaterialExpressionScalarParameter* E = CastChecked<UMaterialExpressionScalarParameter>(Create(UMaterialExpressionScalarParameter::StaticClass()));
			E->ParameterName = Name;
			E->DefaultValue = Default;
			E->Group = FName(Group);
			E->SliderMin = Min;
			E->SliderMax = Max;
			return E;
		};
		auto Vector = [&Create](FName Name, const FLinearColor& Default, const TCHAR* Group) -> UMaterialExpression*
		{
			UMaterialExpressionVectorParameter* E = CastChecked<UMaterialExpressionVectorParameter>(Create(UMaterialExpressionVectorParameter::StaticClass()));
			E->ParameterName = Name;
			E->DefaultValue = Default;
			E->Group = FName(Group);
			return E;
		};
		auto TextureArray = [&Create](FName Name, UTexture2DArray* Default, const TCHAR* Group) -> UMaterialExpression*
		{
			UMaterialExpressionTextureObjectParameter* E = CastChecked<UMaterialExpressionTextureObjectParameter>(Create(UMaterialExpressionTextureObjectParameter::StaticClass()));
			E->ParameterName = Name;
			E->Texture = Default;
			E->SamplerType = SAMPLERTYPE_Color;
			E->Group = FName(Group);
			return E;
		};
		auto CityParam = [&Create, Collection](FName Name) -> UMaterialExpression*
		{
			UMaterialExpressionCollectionParameter* E = CastChecked<UMaterialExpressionCollectionParameter>(Create(UMaterialExpressionCollectionParameter::StaticClass()));
			E->Collection = Collection;
			E->ParameterName = Name;
			E->ParameterId = Collection->GetParameterId(Name);
			return E;
		};

		// --- Geometry inputs
		UMaterialExpressionTextureCoordinate* UV0 = CastChecked<UMaterialExpressionTextureCoordinate>(Create(UMaterialExpressionTextureCoordinate::StaticClass()));
		UV0->CoordinateIndex = 0;
		UMaterialExpressionTextureCoordinate* UVData = CastChecked<UMaterialExpressionTextureCoordinate>(Create(UMaterialExpressionTextureCoordinate::StaticClass()));
		UVData->CoordinateIndex = FMath::Clamp(GetDefault<UParallaxWindowSettings>()->WindowDataUVChannel, 1, 7);

		UMaterialExpression* CameraVector = Create(UMaterialExpressionCameraVectorWS::StaticClass());
		UMaterialExpression* VertexNormal = Create(UMaterialExpressionVertexNormalWS::StaticClass());

		UMaterialExpressionConstant3Vector* LocalUp = CastChecked<UMaterialExpressionConstant3Vector>(Create(UMaterialExpressionConstant3Vector::StaticClass(), -1150));
		LocalUp->Constant = FLinearColor(0.f, 0.f, 1.f);
		UMaterialExpressionTransform* UpToWorld = CastChecked<UMaterialExpressionTransform>(Create(UMaterialExpressionTransform::StaticClass()));
		UpToWorld->TransformSourceType = TRANSFORMSOURCE_Local;
		UpToWorld->TransformType = TRANSFORM_World;
		UpToWorld->Input.Connect(0, LocalUp);

		UMaterialExpression* PixelDepth = Create(UMaterialExpressionPixelDepth::StaticClass());

		// --- Seeds
		UMaterialExpressionCustomPrimitiveData* SeedCPD = CastChecked<UMaterialExpressionCustomPrimitiveData>(Create(UMaterialExpressionCustomPrimitiveData::StaticClass()));
		SeedCPD->DataIndex = 0;
		UMaterialExpressionPerInstanceCustomData* SeedInstance = CastChecked<UMaterialExpressionPerInstanceCustomData>(Create(UMaterialExpressionPerInstanceCustomData::StaticClass()));
		SeedInstance->DataIndex = 0;
		SeedInstance->ConstDefaultValue = 0.f;
		UMaterialExpression* InstanceRandom = Create(UMaterialExpressionPerInstanceRandom::StaticClass());

		// Object position -> small float (Frac also drops large-world-coordinate precision before the Custom node).
		UMaterialExpression* ObjectPosition = Create(UMaterialExpressionObjectPositionWS::StaticClass(), -1400);
		UMaterialExpressionMultiply* PositionScale = CastChecked<UMaterialExpressionMultiply>(Create(UMaterialExpressionMultiply::StaticClass(), -1150));
		PositionScale->A.Connect(0, ObjectPosition);
		PositionScale->ConstB = 0.000731f;
		UMaterialExpressionFrac* PositionFrac = CastChecked<UMaterialExpressionFrac>(Create(UMaterialExpressionFrac::StaticClass()));
		PositionFrac->Input.Connect(0, PositionScale);

		// --- Parameters
		UMaterialExpression* Room = TextureArray(RoomTextures, DefaultRooms, TEXT("01 Room"));
		UMaterialExpression* Depth = Scalar(RoomDepth, 0.5f, TEXT("01 Room"), 0.05f, 0.95f);

		UMaterialExpression* Lit = Scalar(LitPercent, 0.4f, TEXT("02 Lighting"), 0.f, 1.f);
		UMaterialExpression* Warm = Scalar(WarmRatio, 0.7f, TEXT("02 Lighting"), 0.f, 1.f);
		UMaterialExpression* WarmColor = Vector(TEXT("Warm Color"), FLinearColor(1.0f, 0.72f, 0.42f), TEXT("02 Lighting"));
		UMaterialExpression* ColdColor = Vector(TEXT("Cold Color"), FLinearColor(0.75f, 0.88f, 1.0f), TEXT("02 Lighting"));
		UMaterialExpression* BrightMin = Scalar(TEXT("Brightness Min"), 0.6f, TEXT("02 Lighting"), 0.f, 2.f);
		UMaterialExpression* BrightMax = Scalar(TEXT("Brightness Max"), 1.4f, TEXT("02 Lighting"), 0.f, 4.f);
		UMaterialExpression* Intensity = Scalar(TEXT("Light Intensity"), 6.f, TEXT("02 Lighting"), 0.f, 50.f);
		UMaterialExpression* Unlit = Scalar(TEXT("Unlit Level"), 0.03f, TEXT("02 Lighting"), 0.f, 1.f);
		UMaterialExpression* DayInterior = Scalar(TEXT("Day Interior Brightness"), 0.25f, TEXT("02 Lighting"), 0.f, 4.f);
		UMaterialExpression* UseGlobal = Scalar(UseGlobalLighting, 1.f, TEXT("02 Lighting"), 0.f, 1.f);

		UMaterialExpression* Floors = Scalar(FloorBlend, 0.3f, TEXT("03 Patterns"), 0.f, 1.f);
		UMaterialExpression* Blinds = Scalar(BlindsAmount, 0.35f, TEXT("03 Patterns"), 0.f, 1.f);
		UMaterialExpression* BlindsColor = Vector(TEXT("Blinds Color"), FLinearColor(0.85f, 0.82f, 0.75f), TEXT("03 Patterns"));
		UMaterialExpression* BlindsSlats = Scalar(TEXT("Blinds Slats"), 24.f, TEXT("03 Patterns"), 1.f, 80.f);

		UMaterialExpression* DayNight = Scalar(TEXT("Day Night"), 1.f, TEXT("04 Day Night"), 0.f, 1.f);
		UMaterialExpression* UseGlobalDN = Scalar(TEXT("Use Global Day Night"), 1.f, TEXT("04 Day Night"), 0.f, 1.f);
		UMaterialExpression* CityDN = CityParam(CityDayNight);
		UMaterialExpression* CityLit = CityParam(CityLitPercent);
		UMaterialExpression* CityWarm = CityParam(CityWarmRatio);

		UMaterialExpression* GlassRoughness = Scalar(TEXT("Glass Roughness"), 0.05f, TEXT("05 Glass"), 0.f, 1.f);
		UMaterialExpression* DayReflect = Scalar(TEXT("Day Reflectivity"), 0.35f, TEXT("05 Glass"), 0.f, 1.f);
		UMaterialExpression* NightReflect = Scalar(TEXT("Night Reflectivity"), 0.04f, TEXT("05 Glass"), 0.f, 1.f);
		UMaterialExpression* GlassTint = Vector(TEXT("Glass Tint"), FLinearColor(0.9f, 0.95f, 1.0f), TEXT("05 Glass"));

		UMaterialExpression* FallbackDistance = Scalar(TEXT("Fallback Distance"), 15000.f, TEXT("06 Distance"), 0.f, 100000.f);
		UMaterialExpression* FallbackFade = Scalar(TEXT("Fallback Fade"), 3000.f, TEXT("06 Distance"), 1.f, 20000.f);

		UMaterialExpression* UseFg = Scalar(UseForeground, 0.f, TEXT("07 Storefront"), 0.f, 1.f);
		UMaterialExpression* Fg = TextureArray(ForegroundTextures, DefaultForeground, TEXT("07 Storefront"));
		UMaterialExpression* FgDepth = Scalar(TEXT("Foreground Depth"), 0.08f, TEXT("07 Storefront"), 0.f, 0.5f);

		// --- Custom node (names must match Shaders/ParallaxWindowCustomNode.hlsl)
		const FPin Pins[] =
		{
			{ TEXT("UV"), UV0, 0 },
			{ TEXT("WindowData"), UVData, 0 },
			{ TEXT("CamVec"), CameraVector, 0 },
			{ TEXT("NormalWS"), VertexNormal, 0 },
			{ TEXT("UpWS"), UpToWorld, 0 },
			{ TEXT("ViewDepth"), PixelDepth, 0 },
			{ TEXT("SeedCPD"), SeedCPD, 0 },
			{ TEXT("SeedInstance"), SeedInstance, 0 },
			{ TEXT("InstanceRandom"), InstanceRandom, 0 },
			{ TEXT("ObjPosFrac"), PositionFrac, 0 },
			{ TEXT("Room"), Room, 0 },
			{ TEXT("Foreground"), Fg, 0 },
			{ TEXT("RoomDepth"), Depth, 0 },
			{ TEXT("LitPercent"), Lit, 0 },
			{ TEXT("WarmRatio"), Warm, 0 },
			{ TEXT("WarmColor"), WarmColor, 0 },
			{ TEXT("ColdColor"), ColdColor, 0 },
			{ TEXT("BrightnessMin"), BrightMin, 0 },
			{ TEXT("BrightnessMax"), BrightMax, 0 },
			{ TEXT("LightIntensity"), Intensity, 0 },
			{ TEXT("UnlitLevel"), Unlit, 0 },
			{ TEXT("DayInterior"), DayInterior, 0 },
			{ TEXT("FloorBlend"), Floors, 0 },
			{ TEXT("BlindsAmount"), Blinds, 0 },
			{ TEXT("BlindsColor"), BlindsColor, 0 },
			{ TEXT("BlindsSlats"), BlindsSlats, 0 },
			{ TEXT("DayNight"), DayNight, 0 },
			{ TEXT("UseGlobalLighting"), UseGlobal, 0 },
			{ TEXT("UseGlobalDayNight"), UseGlobalDN, 0 },
			{ TEXT("GlobalDayNight"), CityDN, 0 },
			{ TEXT("GlobalLitPercent"), CityLit, 0 },
			{ TEXT("GlobalWarmRatio"), CityWarm, 0 },
			{ TEXT("DayReflectivity"), DayReflect, 0 },
			{ TEXT("NightReflectivity"), NightReflect, 0 },
			{ TEXT("GlassTint"), GlassTint, 0 },
			{ TEXT("FallbackDistance"), FallbackDistance, 0 },
			{ TEXT("FallbackFade"), FallbackFade, 0 },
			{ TEXT("UseForeground"), UseFg, 0 },
			{ TEXT("ForegroundDepth"), FgDepth, 0 },
		};

		UMaterialExpressionCustom* Custom = CastChecked<UMaterialExpressionCustom>(
			UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionCustom::StaticClass(), -350, 0));
		Custom->Description = TEXT("ParallaxWindow");
		Custom->Code = Code;
		Custom->OutputType = CMOT_Float3;
		Custom->Inputs.Reset();
		for (const FPin& Pin : Pins)
		{
			FCustomInput& Input = Custom->Inputs.AddDefaulted_GetRef();
			Input.InputName = FName(Pin.Input);
			Input.Input.Connect(Pin.OutputIndex, Pin.Expression);
		}
		Custom->AdditionalOutputs.Reset();
		FCustomOutput& BaseColorOut = Custom->AdditionalOutputs.AddDefaulted_GetRef();
		BaseColorOut.OutputName = FName(TEXT("BaseColorOut"));
		BaseColorOut.OutputType = CMOT_Float3;
		Custom->PostEditChange(); // rebuilds the output pins: 0 = Emissive (return), 1 = BaseColorOut

		UMaterialExpressionConstant* MetallicOne = CastChecked<UMaterialExpressionConstant>(
			UMaterialEditingLibrary::CreateMaterialExpression(Material, UMaterialExpressionConstant::StaticClass(), -350, 300));
		MetallicOne->R = 1.f;

		Material->GetExpressionInputForProperty(MP_EmissiveColor)->Connect(0, Custom);
		Material->GetExpressionInputForProperty(MP_BaseColor)->Connect(1, Custom);
		Material->GetExpressionInputForProperty(MP_Metallic)->Connect(0, MetallicOne);
		Material->GetExpressionInputForProperty(MP_Roughness)->Connect(0, GlassRoughness);

		UMaterialEditingLibrary::RecompileMaterial(Material);
		Material->MarkPackageDirty();
		Report += FString::Printf(TEXT("Master material: %s (%d custom node inputs, shader %s)\n"), *Material->GetPathName(), UE_ARRAY_COUNT(Pins), *ShaderPath);
		return Material;
	}

	static UMaterialInstanceConstant* GetOrCreateInstance(EParallaxWindowClass Class, UMaterial* Parent, bool& bOutCreated)
	{
		const FString Folder = ToolFolder();
		const FString Name = InstanceName(Class);
		bOutCreated = false;

		UMaterialInstanceConstant* Instance = LoadAssetIfExists<UMaterialInstanceConstant>(Folder, Name);
		if (!Instance)
		{
			UMaterialInstanceConstantFactoryNew* Factory = NewObject<UMaterialInstanceConstantFactoryNew>();
			Factory->InitialParent = Parent;
			Instance = Cast<UMaterialInstanceConstant>(AssetTools().CreateAsset(Name, Folder, UMaterialInstanceConstant::StaticClass(), Factory));
			bOutCreated = Instance != nullptr;
		}
		else if (Instance->Parent != Parent)
		{
			Instance->SetParentEditorOnly(Parent);
		}
		return Instance;
	}

	static UMaterialInstanceConstant* LoadClassInstance(EParallaxWindowClass Class)
	{
		const UParallaxWindowSettings* Settings = GetDefault<UParallaxWindowSettings>();
		if (UMaterialInstanceConstant* FromSettings = Cast<UMaterialInstanceConstant>(Settings->GetClassMaterial(Class).LoadSynchronous()))
		{
			return FromSettings;
		}
		return LoadAssetIfExists<UMaterialInstanceConstant>(ToolFolder(), InstanceName(Class));
	}
}

// ====================================================================== City controls

UMaterialParameterCollection* FParallaxWindowMaterialBuilder::GetCityCollection(bool bCreateIfMissing)
{
	using namespace ParallaxWindowBuilderPrivate;
	using namespace ParallaxWindowParams;

	const FString Folder = ToolFolder();
	UMaterialParameterCollection* Collection = LoadAssetIfExists<UMaterialParameterCollection>(Folder, CollectionName);
	if (!Collection && !bCreateIfMissing)
	{
		return nullptr;
	}
	if (!Collection)
	{
		Collection = NewAsset<UMaterialParameterCollection>(Folder, CollectionName);
	}

	struct FDefault { FName Name; float Value; };
	const FDefault Defaults[] = { { CityDayNight, 1.f }, { CityLitPercent, 0.4f }, { CityWarmRatio, 0.7f } };
	bool bChanged = false;
	for (const FDefault& Default : Defaults)
	{
		const bool bExists = Collection->ScalarParameters.ContainsByPredicate([&Default](const FCollectionScalarParameter& P) { return P.ParameterName == Default.Name; });
		if (!bExists && bCreateIfMissing)
		{
			if (!bChanged)
			{
				Collection->PreEditChange(nullptr);
				bChanged = true;
			}
			FCollectionScalarParameter Parameter;
			Parameter.ParameterName = Default.Name;
			Parameter.DefaultValue = Default.Value;
			Collection->ScalarParameters.Add(Parameter);
		}
	}
	if (bChanged)
	{
		Collection->PostEditChange();
		Collection->MarkPackageDirty();
	}
	return Collection;
}

float FParallaxWindowMaterialBuilder::GetCityControl(FName Parameter, float Fallback)
{
	if (const UMaterialParameterCollection* Collection = GetCityCollection(false))
	{
		for (const FCollectionScalarParameter& P : Collection->ScalarParameters)
		{
			if (P.ParameterName == Parameter)
			{
				return P.DefaultValue;
			}
		}
	}
	return Fallback;
}

void FParallaxWindowMaterialBuilder::SetCityControl(FName Parameter, float Value)
{
	UMaterialParameterCollection* Collection = GetCityCollection(false);
	if (!Collection)
	{
		return;
	}
	for (FCollectionScalarParameter& P : Collection->ScalarParameters)
	{
		if (P.ParameterName == Parameter && P.DefaultValue != Value)
		{
			// Pre/Post edit so the collection sees the layout is unchanged: only values update, no recompile.
			Collection->PreEditChange(nullptr);
			P.DefaultValue = Value;
			Collection->PostEditChange();
			Collection->MarkPackageDirty();
			return;
		}
	}
}

// ====================================================================== Build materials

bool FParallaxWindowMaterialBuilder::BuildMaterials(FString& OutReport)
{
	using namespace ParallaxWindowBuilderPrivate;
	using namespace ParallaxWindowParams;

	FScopedSlowTask Task(5.f, LOCTEXT("BuildingMaterials", "Building parallax window materials..."));
	Task.MakeDialog();

	Task.EnterProgressFrame(1.f, LOCTEXT("Collection", "Material Parameter Collection"));
	UMaterialParameterCollection* Collection = GetCityCollection(true);
	OutReport += FString::Printf(TEXT("City controls: %s\n"), *Collection->GetPathName());

	Task.EnterProgressFrame(1.f, LOCTEXT("Placeholders", "Placeholder textures"));
	UTexture2DArray* DefaultRooms = GetOrCreateDefaultRooms();
	UTexture2DArray* DefaultForeground = GetOrCreateDefaultForeground();

	Task.EnterProgressFrame(1.f, LOCTEXT("Master", "Master material"));
	UMaterial* Master = BuildMaster(Collection, DefaultRooms, DefaultForeground, OutReport);
	if (!Master)
	{
		return false;
	}

	Task.EnterProgressFrame(1.f, LOCTEXT("Instances", "Material instances"));
	UParallaxWindowSettings* Settings = GetMutableDefault<UParallaxWindowSettings>();
	bool bSettingsChanged = false;
	TArray<UObject*> ToSave = { Collection, DefaultRooms, DefaultForeground, Master };

	for (int32 ClassIndex = 0; ClassIndex < ParallaxWindow::NumClasses; ++ClassIndex)
	{
		const EParallaxWindowClass Class = static_cast<EParallaxWindowClass>(ClassIndex);
		bool bCreated = false;
		UMaterialInstanceConstant* Instance = GetOrCreateInstance(Class, Master, bCreated);
		if (!Instance)
		{
			OutReport += FString::Printf(TEXT("ERROR: could not create %s\n"), *InstanceName(Class));
			continue;
		}

		if (bCreated && Class == EParallaxWindowClass::Storefront)
		{
			// Shops: deeper rooms, mostly lit, their own lighting values (not the city sliders).
			UMaterialEditingLibrary::SetMaterialInstanceScalarParameterValue(Instance, RoomDepth, 0.7f);
			UMaterialEditingLibrary::SetMaterialInstanceScalarParameterValue(Instance, UseGlobalLighting, 0.f);
			UMaterialEditingLibrary::SetMaterialInstanceScalarParameterValue(Instance, LitPercent, 0.85f);
			UMaterialEditingLibrary::SetMaterialInstanceScalarParameterValue(Instance, WarmRatio, 0.8f);
			UMaterialEditingLibrary::SetMaterialInstanceScalarParameterValue(Instance, BlindsAmount, 0.05f);
			UMaterialEditingLibrary::SetMaterialInstanceScalarParameterValue(Instance, FloorBlend, 0.f);
		}
		UMaterialEditingLibrary::UpdateMaterialInstance(Instance);
		Instance->MarkPackageDirty();
		ToSave.Add(Instance);
		OutReport += FString::Printf(TEXT("%s %s\n"), bCreated ? TEXT("Created") : TEXT("Updated"), *Instance->GetPathName());

		// Analyze uses these for the Parallax_* slots.
		TSoftObjectPtr<UMaterialInterface>* Slot = nullptr;
		switch (Class)
		{
		case EParallaxWindowClass::Square:     Slot = &Settings->SquareMaterial; break;
		case EParallaxWindowClass::Portrait:   Slot = &Settings->PortraitMaterial; break;
		case EParallaxWindowClass::Landscape:  Slot = &Settings->LandscapeMaterial; break;
		case EParallaxWindowClass::Storefront: Slot = &Settings->StorefrontMaterial; break;
		}
		if (Slot && Slot->IsNull())
		{
			*Slot = Instance;
			bSettingsChanged = true;
		}
	}

	if (bSettingsChanged)
	{
		Settings->TryUpdateDefaultConfigFile();
		OutReport += TEXT("Stored the instances in Project Settings > Parallax Window Tool > Materials.\n");
	}

	Task.EnterProgressFrame(1.f, LOCTEXT("Saving", "Saving"));
	SaveAll(ToSave);
	return true;
}

// ====================================================================== Texture library

UParallaxTextureLibrary* FParallaxWindowMaterialBuilder::GetTextureLibrary()
{
	const UParallaxWindowSettings* Settings = GetDefault<UParallaxWindowSettings>();
	return Settings->TextureLibrary.IsValid() ? Cast<UParallaxTextureLibrary>(Settings->TextureLibrary.TryLoad()) : nullptr;
}

UParallaxTextureLibrary* FParallaxWindowMaterialBuilder::CreateTextureLibrary()
{
	using namespace ParallaxWindowBuilderPrivate;

	if (UParallaxTextureLibrary* Existing = GetTextureLibrary())
	{
		return Existing;
	}
	const FString Folder = ToolFolder();
	UParallaxTextureLibrary* Library = LoadAssetIfExists<UParallaxTextureLibrary>(Folder, LibraryName);
	if (!Library)
	{
		Library = NewAsset<UParallaxTextureLibrary>(Folder, LibraryName);
		SaveAll({ Library });
	}
	UParallaxWindowSettings* Settings = GetMutableDefault<UParallaxWindowSettings>();
	Settings->TextureLibrary = FSoftObjectPath(Library);
	Settings->TryUpdateDefaultConfigFile();
	return Library;
}

bool FParallaxWindowMaterialBuilder::RebuildTextureArrays(UParallaxTextureLibrary* Library, FString& OutReport)
{
	using namespace ParallaxWindowBuilderPrivate;
	using namespace ParallaxWindowParams;

	if (!Library)
	{
		OutReport += TEXT("ERROR: no texture library. Create one first.\n");
		return false;
	}

	// Make sure the instances exist.
	if (!LoadClassInstance(EParallaxWindowClass::Square))
	{
		if (!BuildMaterials(OutReport))
		{
			return false;
		}
	}

	const FString Folder = FPackageName::GetLongPackagePath(Library->GetOutermost()->GetName()) / TEXT("Arrays");
	const FString Prefix = Library->GetName().Replace(TEXT("DA_"), TEXT(""));

	const EParallaxTexturePool Pools[] =
	{
		EParallaxTexturePool::Square, EParallaxTexturePool::Portrait, EParallaxTexturePool::Landscape,
		EParallaxTexturePool::Storefront, EParallaxTexturePool::StorefrontForeground,
	};

	FScopedSlowTask Task(UE_ARRAY_COUNT(Pools), LOCTEXT("PackingArrays", "Packing texture arrays..."));
	Task.MakeDialog();

	Library->Modify();
	TArray<UObject*> ToSave = { Library };

	for (const EParallaxTexturePool Pool : Pools)
	{
		const TCHAR* PoolName = UParallaxTextureLibrary::GetPoolName(Pool);
		Task.EnterProgressFrame(1.f, FText::FromString(PoolName));

		const bool bForeground = Pool == EParallaxTexturePool::StorefrontForeground;
		const EParallaxWindowClass Class = bForeground ? EParallaxWindowClass::Storefront : static_cast<EParallaxWindowClass>(static_cast<uint8>(Pool));
		const FIntPoint Size = Library->GetSize(Pool);

		TArray<TArray<FColor>> Slices;
		bool bHasAlpha = false;
		for (UTexture2D* Texture : Library->GetPool(Pool))
		{
			if (!Texture)
			{
				continue;
			}
			TArray<FColor> Pixels;
			FString Warning;
			if (ReadSlice(Texture, Size.X, Size.Y, Pixels, Warning))
			{
				bHasAlpha |= Pixels.ContainsByPredicate([](const FColor& C) { return C.A < 250; });
				Slices.Add(MoveTemp(Pixels));
			}
			if (!Warning.IsEmpty())
			{
				OutReport += FString::Printf(TEXT("  warning: %s\n"), *Warning);
			}
		}

		UTexture2DArray* Array = nullptr;
		if (Slices.Num() > 0)
		{
			Array = WriteTextureArray(Folder, FString::Printf(TEXT("T_%s_%s_Array"), *Prefix, PoolName), Size.X, Size.Y, Slices, bHasAlpha || bForeground);
			Library->GetArray(Pool) = Array;
			ToSave.Add(Array);
			OutReport += FString::Printf(TEXT("%s: %d texture(s) -> %s (%dx%d)\n"), PoolName, Slices.Num(), *Array->GetPathName(), Size.X, Size.Y);
		}
		else
		{
			Library->GetArray(Pool) = nullptr;
			Array = bForeground ? GetOrCreateDefaultForeground() : GetOrCreateDefaultRooms();
			OutReport += FString::Printf(TEXT("%s: pool empty, using placeholder %s\n"), PoolName, *GetNameSafe(Array));
		}

		if (UMaterialInstanceConstant* Instance = LoadClassInstance(Class))
		{
			Instance->Modify();
			UMaterialEditingLibrary::SetMaterialInstanceTextureParameterValue(Instance, bForeground ? ForegroundTextures : RoomTextures, Array);
			if (bForeground)
			{
				UMaterialEditingLibrary::SetMaterialInstanceScalarParameterValue(Instance, UseForeground, Slices.Num() > 0 ? 1.f : 0.f);
			}
			UMaterialEditingLibrary::UpdateMaterialInstance(Instance);
			Instance->MarkPackageDirty();
			ToSave.AddUnique(Instance);
		}
		else
		{
			OutReport += FString::Printf(TEXT("  warning: no material instance for %s; press Build / Update Materials.\n"), ParallaxWindow::GetClassDisplayName(Class));
		}
	}

	Library->MarkPackageDirty();
	SaveAll(ToSave);
	return true;
}

// ====================================================================== Meshes and level

bool FParallaxWindowMaterialBuilder::IsParallaxMesh(const UStaticMesh* Mesh)
{
	if (!Mesh)
	{
		return false;
	}
	for (const FStaticMaterial& Material : Mesh->GetStaticMaterials())
	{
		if (Material.MaterialSlotName.ToString().StartsWith(TEXT("Parallax_")))
		{
			return true;
		}
	}
	return false;
}

int32 FParallaxWindowMaterialBuilder::AssignClassMaterials(const TArray<UStaticMesh*>& Meshes, FString& OutReport)
{
	using namespace ParallaxWindowBuilderPrivate;

	UMaterialInterface* ClassMaterials[ParallaxWindow::NumClasses];
	for (int32 ClassIndex = 0; ClassIndex < ParallaxWindow::NumClasses; ++ClassIndex)
	{
		const EParallaxWindowClass Class = static_cast<EParallaxWindowClass>(ClassIndex);
		ClassMaterials[ClassIndex] = GetDefault<UParallaxWindowSettings>()->GetClassMaterial(Class).LoadSynchronous();
		if (!ClassMaterials[ClassIndex])
		{
			ClassMaterials[ClassIndex] = LoadClassInstance(Class);
		}
	}

	int32 Changed = 0;
	TArray<UObject*> ToSave;
	for (UStaticMesh* Mesh : Meshes)
	{
		if (!IsParallaxMesh(Mesh))
		{
			OutReport += FString::Printf(TEXT("%s has no Parallax_* slots; analyze it first.\n"), *GetNameSafe(Mesh));
			continue;
		}
		TArray<FStaticMaterial> Materials = Mesh->GetStaticMaterials();
		int32 Assigned = 0;
		for (FStaticMaterial& Material : Materials)
		{
			for (int32 ClassIndex = 0; ClassIndex < ParallaxWindow::NumClasses; ++ClassIndex)
			{
				if (Material.MaterialSlotName == ParallaxWindow::GetClassSlotName(static_cast<EParallaxWindowClass>(ClassIndex)) && ClassMaterials[ClassIndex])
				{
					Material.MaterialInterface = ClassMaterials[ClassIndex];
					++Assigned;
				}
			}
		}
		Mesh->Modify();
		Mesh->SetStaticMaterials(Materials);
		Mesh->PostEditChange();
		Mesh->MarkPackageDirty();
		ToSave.Add(Mesh);
		++Changed;
		OutReport += FString::Printf(TEXT("%s: assigned %d slot(s)\n"), *Mesh->GetName(), Assigned);
	}
	SaveAll(ToSave);
	return Changed;
}

int32 FParallaxWindowMaterialBuilder::RandomizeSeedsInLevel(FString& OutReport)
{
	UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
	if (!World)
	{
		OutReport += TEXT("ERROR: no editor world.\n");
		return 0;
	}

	const FScopedTransaction Transaction(LOCTEXT("RandomizeSeeds", "Randomize Parallax Window Seeds"));
	FRandomStream Random(FPlatformTime::Cycles());
	auto NewSeed = [&Random]() { return static_cast<float>(Random.RandRange(1, 999999)); };

	int32 Components = 0;
	int32 Instances = 0;
	for (TActorIterator<AActor> It(World); It; ++It)
	{
		TInlineComponentArray<UStaticMeshComponent*> MeshComponents(*It);
		for (UStaticMeshComponent* Component : MeshComponents)
		{
			if (!Component || !IsParallaxMesh(Component->GetStaticMesh()))
			{
				continue;
			}
			Component->Modify();
			if (UInstancedStaticMeshComponent* Instanced = Cast<UInstancedStaticMeshComponent>(Component))
			{
				if (Instanced->NumCustomDataFloats < 1)
				{
					Instanced->SetNumCustomDataFloats(1);
				}
				for (int32 Index = 0; Index < Instanced->GetInstanceCount(); ++Index)
				{
					Instanced->SetCustomDataValue(Index, 0, NewSeed(), false);
					++Instances;
				}
				Instanced->MarkRenderStateDirty();
			}
			else
			{
				Component->SetDefaultCustomPrimitiveDataFloat(0, NewSeed());
			}
			++Components;
		}
	}

	OutReport += FString::Printf(TEXT("Randomized seeds on %d component(s) and %d instance(s) in %s. Undo with Ctrl+Z.\n"),
		Components, Instances, *World->GetName());
	return Components;
}

#undef LOCTEXT_NAMESPACE
