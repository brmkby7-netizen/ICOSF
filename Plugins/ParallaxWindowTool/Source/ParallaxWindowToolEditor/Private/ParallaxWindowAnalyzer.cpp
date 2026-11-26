#include "ParallaxWindowAnalyzer.h"
#include "ParallaxWindowSettings.h"

#include "Engine/StaticMesh.h"
#include "StaticMeshResources.h"
#include "MeshDescription.h"
#include "StaticMeshAttributes.h"

// Dynamic Mesh (GeometryCore / DynamicMesh / MeshConversion)
#include "DynamicMesh/DynamicMesh3.h"
#include "Selections/MeshConnectedComponents.h"
#include "MeshDescriptionToDynamicMesh.h"

#include "AssetRegistry/AssetData.h"
#include "AssetToolsModule.h"
#include "IAssetTools.h"
#include "FileHelpers.h"
#include "Misc/PackageName.h"
#include "Misc/ScopedSlowTask.h"
#include "Logging/MessageLog.h"
#include "Modules/ModuleManager.h"
#include "UObject/Package.h"
#include "UObject/UnrealType.h"

#define LOCTEXT_NAMESPACE "ParallaxWindowAnalyzer"

DEFINE_LOG_CATEGORY_STATIC(LogParallaxWindow, Log, All);

using namespace UE::Geometry;

namespace ParallaxWindowAnalyzerPrivate
{
	static const FName MessageLogName(TEXT("ParallaxWindowTool"));

	/** Strips suffixes Blender / the FBX importer add to slot names: "_Skin12", "_001", ".001". */
	static FString StripSlotSuffix(const FString& In)
	{
		FString Out = In;

		int32 SkinPos = Out.Find(TEXT("_Skin"), ESearchCase::IgnoreCase, ESearchDir::FromEnd);
		if (SkinPos != INDEX_NONE && SkinPos + 5 < Out.Len() && Out.Mid(SkinPos + 5).IsNumeric())
		{
			Out.LeftInline(SkinPos);
		}

		int32 SepPos = INDEX_NONE;
		const int32 Underscore = Out.Find(TEXT("_"), ESearchCase::CaseSensitive, ESearchDir::FromEnd);
		const int32 Dot = Out.Find(TEXT("."), ESearchCase::CaseSensitive, ESearchDir::FromEnd);
		SepPos = FMath::Max(Underscore, Dot);
		if (SepPos > 0 && SepPos + 1 < Out.Len() && Out.Mid(SepPos + 1).IsNumeric())
		{
			Out.LeftInline(SepPos);
		}
		return Out;
	}

	static bool SlotNameMatches(const FString& Candidate, const FString& Wanted)
	{
		if (Candidate.IsEmpty() || Wanted.IsEmpty() || Candidate == TEXT("None"))
		{
			return false;
		}
		return Candidate.Equals(Wanted, ESearchCase::IgnoreCase)
			|| StripSlotSuffix(Candidate).Equals(Wanted, ESearchCase::IgnoreCase);
	}

	static bool StaticMaterialMatches(const FStaticMaterial& Material, const FString& Wanted)
	{
		return SlotNameMatches(Material.MaterialSlotName.ToString(), Wanted)
			|| SlotNameMatches(Material.ImportedMaterialSlotName.ToString(), Wanted)
			|| (Material.MaterialInterface && SlotNameMatches(Material.MaterialInterface->GetName(), Wanted));
	}

	/** PCG hash (Jarzynski & Olano). Same function can be used in HLSL later. */
	static uint32 PcgHash(uint32 V)
	{
		const uint32 State = V * 747796405u + 2891336453u;
		const uint32 Word = ((State >> ((State >> 28u) + 4u)) ^ State) * 277803737u;
		return (Word >> 22u) ^ Word;
	}

	/** Stable per-window ID in [0,1) from the window center quantized to 1 cm, so re-analysis keeps the same IDs. */
	static float WindowRandomId(const FVector& Center)
	{
		const uint32 X = static_cast<uint32>(FMath::RoundToInt64(Center.X));
		const uint32 Y = static_cast<uint32>(FMath::RoundToInt64(Center.Y));
		const uint32 Z = static_cast<uint32>(FMath::RoundToInt64(Center.Z));
		const uint32 H = PcgHash(X ^ PcgHash(Y ^ PcgHash(Z)));
		// 24 bits: exactly representable in a 32-bit float UV.
		return static_cast<float>(H & 0x00FFFFFFu) / 16777216.0f;
	}

	static void CopyPropertyByName(const UStaticMesh* From, UStaticMesh* To, const TCHAR* PropertyName)
	{
		if (FProperty* Property = UStaticMesh::StaticClass()->FindPropertyByName(FName(PropertyName)))
		{
			Property->CopyCompleteValue_InContainer(To, From);
		}
	}

	/** When re-analyzing into an existing processed asset, pull the source's build settings across. */
	static void CopyMeshSettings(const UStaticMesh* Source, UStaticMesh* Target)
	{
		// Copied by reflection so this does not depend on per-version accessors.
		CopyPropertyByName(Source, Target, TEXT("NaniteSettings"));
		CopyPropertyByName(Source, Target, TEXT("LightMapResolution"));
		CopyPropertyByName(Source, Target, TEXT("LightMapCoordinateIndex"));
		CopyPropertyByName(Source, Target, TEXT("LightmapUVDensity"));
		CopyPropertyByName(Source, Target, TEXT("bAllowCPUAccess"));

		if (Source->GetNumSourceModels() > 0 && Target->GetNumSourceModels() > 0)
		{
			Target->GetSourceModel(0).BuildSettings = Source->GetSourceModel(0).BuildSettings;
			Target->GetSourceModel(0).ReductionSettings = Source->GetSourceModel(0).ReductionSettings;
			Target->GetSourceModel(0).ScreenSize = Source->GetSourceModel(0).ScreenSize;
		}
	}

	struct FSkipCollector
	{
		FParallaxAnalyzeSummary& Summary;
		void Skip(int32 ComponentIndex, const FVector& Center, const FString& Reason) const
		{
			FParallaxSkippedWindow& S = Summary.Skipped.AddDefaulted_GetRef();
			S.ComponentIndex = ComponentIndex;
			S.Center = Center;
			S.Reason = Reason;
			UE_LOG(LogParallaxWindow, Log, TEXT("  Skipped glass component %d at (%.0f, %.0f, %.0f): %s"),
				ComponentIndex, Center.X, Center.Y, Center.Z, *Reason);
		}
	};
}

FParallaxAnalyzeSummary FParallaxWindowAnalyzer::AnalyzeStaticMesh(UStaticMesh* Source, const UParallaxWindowSettings& S)
{
	using namespace ParallaxWindowAnalyzerPrivate;

	FParallaxAnalyzeSummary Out;
	auto Fail = [&Out](const FString& Message) -> FParallaxAnalyzeSummary
	{
		Out.bSuccess = false;
		Out.Message = Message;
		UE_LOG(LogParallaxWindow, Error, TEXT("%s: %s"), *Out.SourceMeshPath, *Message);
		return Out;
	};

	if (!Source)
	{
		return Fail(TEXT("No static mesh given."));
	}
	Out.SourceMeshPath = Source->GetPathName();
	UE_LOG(LogParallaxWindow, Log, TEXT("Analyzing %s"), *Out.SourceMeshPath);

	if (!S.OutputSuffix.IsEmpty() && Source->GetName().EndsWith(S.OutputSuffix))
	{
		return Fail(FString::Printf(TEXT("'%s' already ends with '%s'; analyze the imported source mesh instead."), *Source->GetName(), *S.OutputSuffix));
	}
	if (S.FloorHeight <= 1.f)
	{
		return Fail(TEXT("Floor Height must be greater than 1 cm."));
	}

	const FMeshDescription* SourceDescription = Source->GetMeshDescription(0);
	if (!SourceDescription || SourceDescription->Triangles().Num() == 0)
	{
		return Fail(TEXT("LOD0 has no mesh description (source geometry). Re-import the mesh."));
	}

	// Work on a copy: the import is never modified.
	FMeshDescription MD = *SourceDescription;
	FStaticMeshAttributes Attributes(MD);
	TPolygonGroupAttributesRef<FName> GroupSlotNames = Attributes.GetPolygonGroupMaterialSlotNames();
	TVertexAttributesRef<FVector3f> Positions = Attributes.GetVertexPositions();
	TVertexInstanceAttributesRef<FVector3f> Normals = Attributes.GetVertexInstanceNormals();
	TVertexInstanceAttributesRef<FVector2f> UVs = Attributes.GetVertexInstanceUVs();

	const TArray<FStaticMaterial>& SourceMaterials = Source->GetStaticMaterials();
	if (SourceMaterials.Num() == 0)
	{
		return Fail(TEXT("Mesh has no material slots."));
	}
	const FString WantedGlass = S.GlassSlotName.ToString();

	// ------------------------------------------------------------------ 1. Find the glass slot
	int32 GlassMaterialIndex = INDEX_NONE;
	for (int32 Index = 0; Index < SourceMaterials.Num(); ++Index)
	{
		if (StaticMaterialMatches(SourceMaterials[Index], WantedGlass))
		{
			GlassMaterialIndex = Index;
			break;
		}
	}

	// Polygon group -> material index (same lookup order as the static mesh builder).
	const FMeshSectionInfoMap& SourceSectionInfo = Source->GetSectionInfoMap();
	TMap<FPolygonGroupID, int32> GroupMaterial;
	TSet<FPolygonGroupID> GlassGroups;
	for (const FPolygonGroupID GroupID : MD.PolygonGroups().GetElementIDs())
	{
		const FName SlotName = GroupSlotNames.IsValid() ? GroupSlotNames[GroupID] : NAME_None;
		int32 MaterialIndex = SlotName.IsNone() ? INDEX_NONE : Source->GetMaterialIndexFromImportedMaterialSlotName(SlotName);
		if (MaterialIndex == INDEX_NONE)
		{
			const int32 SectionIndex = GroupID.GetValue();
			MaterialIndex = SourceSectionInfo.IsValidSection(0, SectionIndex) ? SourceSectionInfo.Get(0, SectionIndex).MaterialIndex : SectionIndex;
		}
		if (!SourceMaterials.IsValidIndex(MaterialIndex))
		{
			Out.Warnings.Add(FString::Printf(TEXT("Polygon group %d ('%s') has no matching material slot; using slot 0."), GroupID.GetValue(), *SlotName.ToString()));
			MaterialIndex = 0;
		}
		GroupMaterial.Add(GroupID, MaterialIndex);

		const bool bGroupIsGlass = (GlassMaterialIndex != INDEX_NONE && MaterialIndex == GlassMaterialIndex)
			|| SlotNameMatches(SlotName.ToString(), WantedGlass);
		if (bGroupIsGlass)
		{
			GlassGroups.Add(GroupID);
			if (GlassMaterialIndex == INDEX_NONE)
			{
				GlassMaterialIndex = MaterialIndex;
			}
		}
	}

	if (GlassMaterialIndex == INDEX_NONE || GlassGroups.Num() == 0)
	{
		FString Slots;
		for (const FStaticMaterial& M : SourceMaterials)
		{
			Slots += FString::Printf(TEXT(" '%s'"), *M.MaterialSlotName.ToString());
		}
		return Fail(FString::Printf(TEXT("No material slot matches the glass slot name '%s'. Slots on this mesh:%s"), *WantedGlass, *Slots));
	}

	// Height reference.
	double BaseZ = 0.0;
	if (S.bMeasureHeightsFromMeshBottom)
	{
		BaseZ = TNumericLimits<double>::Max();
		for (const FVertexID VertexID : MD.Vertices().GetElementIDs())
		{
			BaseZ = FMath::Min(BaseZ, static_cast<double>(Positions[VertexID].Z));
		}
	}

	// UV channels: UV0 for parallax, WindowDataUVChannel for (random ID, floor index).
	const int32 DataChannel = FMath::Clamp(S.WindowDataUVChannel, 1, 7); // static meshes support 8 UV channels
	{
		const FMeshBuildSettings& SourceBuild = Source->GetSourceModel(0).BuildSettings;
		if (SourceBuild.bGenerateLightmapUVs && SourceBuild.DstLightmapIndex == DataChannel)
		{
			return Fail(FString::Printf(TEXT("Lightmap UVs are generated into channel %d, which is the Window Data UV Channel. Change one of them."), DataChannel));
		}
		if (!SourceBuild.bGenerateLightmapUVs && Source->GetLightMapCoordinateIndex() == DataChannel && UVs.GetNumChannels() > DataChannel)
		{
			Out.Warnings.Add(FString::Printf(TEXT("UV channel %d is this mesh's lightmap channel; glass UVs in it will be replaced with window data."), DataChannel));
		}
	}
	if (UVs.GetNumChannels() < DataChannel + 1)
	{
		UVs.SetNumChannels(DataChannel + 1);
		MD.SetNumUVChannels(DataChannel + 1);
	}

	// Final material list: source slots + one slot per class. The glass slot stays for skipped panes.
	TArray<FStaticMaterial> FinalMaterials = SourceMaterials;
	int32 ClassMaterialIndex[ParallaxWindow::NumClasses];
	for (int32 ClassIndex = 0; ClassIndex < ParallaxWindow::NumClasses; ++ClassIndex)
	{
		const EParallaxWindowClass Class = static_cast<EParallaxWindowClass>(ClassIndex);
		const FName SlotName = ParallaxWindow::GetClassSlotName(Class);
		UMaterialInterface* Material = S.GetClassMaterial(Class).LoadSynchronous();
		if (!Material)
		{
			Material = SourceMaterials[GlassMaterialIndex].MaterialInterface;
		}
		FStaticMaterial NewMaterial(Material, SlotName, SlotName);
		NewMaterial.UVChannelData = SourceMaterials[GlassMaterialIndex].UVChannelData;
		ClassMaterialIndex[ClassIndex] = FinalMaterials.Add(NewMaterial);
	}

	// ------------------------------------------------------------------ 2. Dynamic Mesh + connected components
	FDynamicMesh3 DynamicMesh;
	FMeshDescriptionToDynamicMesh Converter;
	Converter.bCalculateMaps = true;       // fills TriIDMap: dynamic triangle -> mesh description triangle
	Converter.bEnableOutputGroups = false;
	Converter.Convert(&MD, DynamicMesh);

	TArray<int32> GlassTriangles;
	for (const int32 Tid : DynamicMesh.TriangleIndicesItr())
	{
		if (Converter.TriIDMap.IsValidIndex(Tid))
		{
			const FTriangleID TriangleID(Converter.TriIDMap[Tid]);
			if (GlassGroups.Contains(MD.GetTrianglePolygonGroup(TriangleID)))
			{
				GlassTriangles.Add(Tid);
			}
		}
	}

	FMeshConnectedComponents Components(&DynamicMesh);
	Components.FindConnectedTriangles(GlassTriangles);
	Out.GlassComponentCount = Components.Num();
	UE_LOG(LogParallaxWindow, Log, TEXT("  %d glass triangles in %d connected components"), GlassTriangles.Num(), Components.Num());

	const FSkipCollector Skipper{ Out };
	TMap<FPolygonID, int32> PolygonMaterialOverride;
	int32 MaxFloor = -1;
	int32 SharedVertexWarnings = 0;

	// ------------------------------------------------------------------ 3-6. Per window
	for (int32 ComponentIndex = 0; ComponentIndex < Components.Num(); ++ComponentIndex)
	{
		const TArray<int32>& DynamicTris = Components.GetComponent(ComponentIndex).Indices;

		TArray<FTriangleID> Triangles;
		Triangles.Reserve(DynamicTris.Num());
		TSet<FVertexID> Vertices;
		FVector AreaVector = FVector::ZeroVector;
		FVector VertexNormalSum = FVector::ZeroVector;
		double DoubleAreaSum = 0.0;

		for (const int32 Tid : DynamicTris)
		{
			const FTriangleID TriangleID(Converter.TriIDMap[Tid]);
			Triangles.Add(TriangleID);

			const TArrayView<const FVertexInstanceID> Instances = MD.GetTriangleVertexInstances(TriangleID);
			FVector P[3];
			for (int32 Corner = 0; Corner < 3; ++Corner)
			{
				const FVertexID VertexID = MD.GetVertexInstanceVertex(Instances[Corner]);
				Vertices.Add(VertexID);
				P[Corner] = FVector(Positions[VertexID]);
				if (Normals.IsValid())
				{
					VertexNormalSum += FVector(Normals[Instances[Corner]]);
				}
			}
			// Same winding convention as FStaticMeshOperations triangle normals.
			const FVector Cross = FVector::CrossProduct(P[2] - P[0], P[1] - P[0]);
			AreaVector += Cross;
			DoubleAreaSum += Cross.Size();
		}

		FVector Centroid = FVector::ZeroVector;
		double MinZ = TNumericLimits<double>::Max();
		for (const FVertexID VertexID : Vertices)
		{
			const FVector P(Positions[VertexID]);
			Centroid += P;
			MinZ = FMath::Min(MinZ, P.Z);
		}
		Centroid /= FMath::Max(1, Vertices.Num());

		if (DoubleAreaSum < UE_KINDA_SMALL_NUMBER)
		{
			Skipper.Skip(ComponentIndex, Centroid, TEXT("zero area"));
			continue;
		}

		// Planarity: a flat pane has all triangle normals aligned. Thick or double-sided glass cancels out.
		const double Planarity = AreaVector.Size() / DoubleAreaSum;
		if (Planarity < 0.98)
		{
			Skipper.Skip(ComponentIndex, Centroid, FString::Printf(TEXT("not a flat single-sided pane (planarity %.2f); thick or double-sided glass?"), Planarity));
			continue;
		}

		FVector Normal = AreaVector.GetSafeNormal();
		// Trust the mesh's vertex normals for which side faces out.
		if (VertexNormalSum.SizeSquared() > UE_KINDA_SMALL_NUMBER && FVector::DotProduct(Normal, VertexNormalSum) < 0.0)
		{
			Normal = -Normal;
		}

		if (FMath::Abs(Normal.Z) > S.MaxNormalZ)
		{
			Skipper.Skip(ComponentIndex, Centroid, FString::Printf(TEXT("not vertical (|normal.z| = %.2f > %.2f)"), FMath::Abs(Normal.Z), S.MaxNormalZ));
			continue;
		}

		// Local frame: up = world Z projected onto the window plane, right = normal x up
		// (seen from outside, right points to the viewer's right in Unreal's left-handed space).
		const FVector Up = (FVector::UpVector - Normal * Normal.Z).GetSafeNormal();
		const FVector Right = FVector::CrossProduct(Normal, Up);

		double MinR = TNumericLimits<double>::Max(), MaxR = TNumericLimits<double>::Lowest();
		double MinU = TNumericLimits<double>::Max(), MaxU = TNumericLimits<double>::Lowest();
		for (const FVertexID VertexID : Vertices)
		{
			const FVector D = FVector(Positions[VertexID]) - Centroid;
			const double R = FVector::DotProduct(D, Right);
			const double U = FVector::DotProduct(D, Up);
			MinR = FMath::Min(MinR, R); MaxR = FMath::Max(MaxR, R);
			MinU = FMath::Min(MinU, U); MaxU = FMath::Max(MaxU, U);
		}

		const double Width = MaxR - MinR;
		const double Height = MaxU - MinU;
		const FVector Center = Centroid + Right * (0.5 * (MinR + MaxR)) + Up * (0.5 * (MinU + MaxU));

		if (Width < S.MinWindowSize || Height < S.MinWindowSize)
		{
			Skipper.Skip(ComponentIndex, Center, FString::Printf(TEXT("too small (%.1f x %.1f cm)"), Width, Height));
			continue;
		}

		const double Area = 0.5 * DoubleAreaSum;
		const double Rectangularity = Area / (Width * Height);
		if (Rectangularity < S.MinRectangularity)
		{
			Skipper.Skip(ComponentIndex, Center, FString::Printf(TEXT("not rectangular (fills %.0f%% of its bounding rectangle, needs %.0f%%)"), Rectangularity * 100.0, S.MinRectangularity * 100.0));
			continue;
		}
		if (Rectangularity > 1.05)
		{
			Skipper.Skip(ComponentIndex, Center, FString::Printf(TEXT("overlapping triangles (area is %.0f%% of its bounding rectangle)"), Rectangularity * 100.0));
			continue;
		}

		// Classification.
		const double BottomHeight = MinZ - BaseZ;
		const double Aspect = Width / Height;
		const int32 FloorIndex = FMath::Max(0, FMath::FloorToInt32((BottomHeight + 0.5) / S.FloorHeight));
		EParallaxWindowClass Class;
		if (BottomHeight < S.GroundFloorHeight)
		{
			Class = EParallaxWindowClass::Storefront;
		}
		else if (Aspect < S.SquareAspectMin)
		{
			Class = EParallaxWindowClass::Portrait;
		}
		else if (Aspect > S.SquareAspectMax)
		{
			Class = EParallaxWindowClass::Landscape;
		}
		else
		{
			Class = EParallaxWindowClass::Square;
		}

		const float RandomId = WindowRandomId(Center);

		// Vertex instances should belong to this pane only (panes are loose); warn if not.
		TSet<FTriangleID> TriangleSet(Triangles);
		bool bShared = false;

		// ---- 5. UVs
		TSet<FVertexInstanceID> Written;
		for (const FTriangleID TriangleID : Triangles)
		{
			for (const FVertexInstanceID InstanceID : MD.GetTriangleVertexInstances(TriangleID))
			{
				if (Written.Contains(InstanceID))
				{
					continue;
				}
				Written.Add(InstanceID);

				if (!bShared)
				{
					for (const FTriangleID Connected : MD.GetVertexInstanceConnectedTriangleIDs(InstanceID))
					{
						if (!TriangleSet.Contains(Connected))
						{
							bShared = true;
							break;
						}
					}
				}

				const FVector D = FVector(Positions[MD.GetVertexInstanceVertex(InstanceID)]) - Centroid;
				// UV0: 0-1 per window, upright, bottom-left origin (v grows upwards).
				const float U0 = static_cast<float>((FVector::DotProduct(D, Right) - MinR) / Width);
				const float V0 = static_cast<float>((FVector::DotProduct(D, Up) - MinU) / Height);
				UVs.Set(InstanceID, 0, FVector2f(FMath::Clamp(U0, 0.f, 1.f), FMath::Clamp(V0, 0.f, 1.f)));
				// Window data: x = random ID, y = floor index.
				UVs.Set(InstanceID, DataChannel, FVector2f(RandomId, static_cast<float>(FloorIndex)));
			}
		}
		if (bShared && SharedVertexWarnings++ < 10)
		{
			Out.Warnings.Add(FString::Printf(TEXT("Window at (%.0f, %.0f, %.0f) shares vertices with other geometry; its neighbors' UVs may change. Separate the pane in Blender (P > By loose parts / Y split)."), Center.X, Center.Y, Center.Z));
		}

		// ---- 7. Material slot per class
		const int32 TargetMaterial = ClassMaterialIndex[static_cast<int32>(Class)];
		for (const FTriangleID TriangleID : Triangles)
		{
			PolygonMaterialOverride.Add(MD.GetTrianglePolygon(TriangleID), TargetMaterial);
		}

		FParallaxWindowRecord& Record = Out.Windows.AddDefaulted_GetRef();
		Record.WindowIndex = Out.Windows.Num() - 1;
		Record.Class = Class;
		Record.Center = Center;
		Record.Normal = Normal;
		Record.Right = Right;
		Record.Up = Up;
		Record.Width = static_cast<float>(Width);
		Record.Height = static_cast<float>(Height);
		Record.AspectRatio = static_cast<float>(Aspect);
		Record.BottomHeight = static_cast<float>(BottomHeight);
		Record.FloorIndex = FloorIndex;
		Record.RandomId = RandomId;
		Record.Rectangularity = static_cast<float>(Rectangularity);

		MaxFloor = FMath::Max(MaxFloor, FloorIndex);
		switch (Class)
		{
		case EParallaxWindowClass::Square:     ++Out.SquareCount; break;
		case EParallaxWindowClass::Portrait:   ++Out.PortraitCount; break;
		case EParallaxWindowClass::Landscape:  ++Out.LandscapeCount; break;
		case EParallaxWindowClass::Storefront: ++Out.StorefrontCount; break;
		}
	}
	if (SharedVertexWarnings > 10)
	{
		Out.Warnings.Add(FString::Printf(TEXT("...and %d more windows sharing vertices."), SharedVertexWarnings - 10));
	}
	Out.FloorCount = MaxFloor + 1;

	if (Out.Windows.Num() == 0)
	{
		return Fail(FString::Printf(TEXT("Found %d glass components but none passed the vertical / rectangular checks. See the skipped list."), Out.GlassComponentCount));
	}

	// ------------------------------------------------------------------ Rebuild polygon groups, one per used material, in material order
	TMap<FPolygonID, int32> PolygonMaterial;
	TSet<int32> UsedMaterialSet;
	for (const FPolygonID PolygonID : MD.Polygons().GetElementIDs())
	{
		const int32* Override = PolygonMaterialOverride.Find(PolygonID);
		const int32 MaterialIndex = Override ? *Override : GroupMaterial.FindChecked(MD.GetPolygonPolygonGroup(PolygonID));
		PolygonMaterial.Add(PolygonID, MaterialIndex);
		UsedMaterialSet.Add(MaterialIndex);
	}
	TArray<int32> UsedMaterials = UsedMaterialSet.Array();
	UsedMaterials.Sort();

	TArray<FPolygonGroupID> OldGroups;
	for (const FPolygonGroupID GroupID : MD.PolygonGroups().GetElementIDs())
	{
		OldGroups.Add(GroupID);
	}

	TMap<int32, FPolygonGroupID> MaterialToGroup;
	for (const int32 MaterialIndex : UsedMaterials)
	{
		const FPolygonGroupID NewGroup = MD.CreatePolygonGroup();
		const FStaticMaterial& Material = FinalMaterials[MaterialIndex];
		GroupSlotNames[NewGroup] = Material.ImportedMaterialSlotName.IsNone() ? Material.MaterialSlotName : Material.ImportedMaterialSlotName;
		MaterialToGroup.Add(MaterialIndex, NewGroup);
	}
	for (const TPair<FPolygonID, int32>& Pair : PolygonMaterial)
	{
		MD.SetPolygonPolygonGroup(Pair.Key, MaterialToGroup.FindChecked(Pair.Value));
	}
	for (const FPolygonGroupID GroupID : OldGroups)
	{
		MD.DeletePolygonGroup(GroupID);
	}
	FElementIDRemappings Remappings;
	MD.Compact(Remappings); // groups are now 0..N-1 in UsedMaterials order => section k uses UsedMaterials[k]

	// ------------------------------------------------------------------ 8. Write the processed asset
	const FString SourceFolder = FPackageName::GetLongPackagePath(Source->GetOutermost()->GetName());
	FString Folder = S.OutputFolder.TrimStartAndEnd();
	if (Folder.IsEmpty())
	{
		Folder = SourceFolder;
	}
	Folder.RemoveFromEnd(TEXT("/"));
	const FString AssetName = Source->GetName() + S.OutputSuffix;
	const FString PackageName = Folder / AssetName;
	const FString ObjectPath = PackageName + TEXT(".") + AssetName;

	UStaticMesh* Target = FindObject<UStaticMesh>(nullptr, *ObjectPath);
	if (!Target && FPackageName::DoesPackageExist(PackageName))
	{
		Target = LoadObject<UStaticMesh>(nullptr, *ObjectPath, nullptr, LOAD_NoWarn | LOAD_Quiet);
		if (!Target)
		{
			return Fail(FString::Printf(TEXT("'%s' exists but is not a static mesh."), *PackageName));
		}
	}

	if (Target)
	{
		CopyMeshSettings(Source, Target);
	}
	else
	{
		IAssetTools& AssetTools = FModuleManager::LoadModuleChecked<FAssetToolsModule>(TEXT("AssetTools")).Get();
		Target = Cast<UStaticMesh>(AssetTools.DuplicateAsset(AssetName, Folder, Source));
		if (!Target)
		{
			return Fail(FString::Printf(TEXT("Could not create '%s'."), *PackageName));
		}
		Out.bCreatedNewAsset = true;
	}

	Target->Modify();
	Target->SetStaticMaterials(FinalMaterials);

	// Section info: section k -> UsedMaterials[k], keeping the source's shadow / collision flags per material.
	{
		TMap<int32, FMeshSectionInfo> SourceInfoByMaterial;
		for (int32 SectionIndex = 0; SectionIndex < SourceSectionInfo.GetSectionNumber(0); ++SectionIndex)
		{
			const FMeshSectionInfo Info = SourceSectionInfo.Get(0, SectionIndex);
			SourceInfoByMaterial.FindOrAdd(Info.MaterialIndex) = Info;
		}

		FMeshSectionInfoMap& SectionInfo = Target->GetSectionInfoMap();
		for (int32 SectionIndex = SectionInfo.GetSectionNumber(0) - 1; SectionIndex >= 0; --SectionIndex)
		{
			SectionInfo.Remove(0, SectionIndex);
		}
		for (int32 SectionIndex = 0; SectionIndex < UsedMaterials.Num(); ++SectionIndex)
		{
			const int32 MaterialIndex = UsedMaterials[SectionIndex];
			const bool bIsClassSlot = MaterialIndex >= SourceMaterials.Num();
			const FMeshSectionInfo* Template = SourceInfoByMaterial.Find(bIsClassSlot ? GlassMaterialIndex : MaterialIndex);
			FMeshSectionInfo Info = Template ? *Template : FMeshSectionInfo(MaterialIndex);
			Info.MaterialIndex = MaterialIndex;
			SectionInfo.Set(0, SectionIndex, Info);
		}
		Target->GetOriginalSectionInfoMap().CopyFrom(SectionInfo);
	}

	FMeshBuildSettings& BuildSettings = Target->GetSourceModel(0).BuildSettings;
	BuildSettings.bRecomputeTangents = true; // UV0 changed on the glass, imported tangents no longer match
	if (S.bForceFullPrecisionUVs)
	{
		BuildSettings.bUseFullPrecisionUVs = true;
	}

	for (int32 LODIndex = 1; LODIndex < Target->GetNumSourceModels(); ++LODIndex)
	{
		if (Target->IsMeshDescriptionValid(LODIndex) && !Target->IsReductionActive(LODIndex))
		{
			Out.Warnings.Add(FString::Printf(TEXT("LOD%d is a custom imported LOD and was not processed; it keeps the plain glass. Use auto-generated LODs or Nanite."), LODIndex));
		}
	}

	FMeshDescription* TargetDescription = Target->GetMeshDescription(0);
	if (!TargetDescription)
	{
		TargetDescription = Target->CreateMeshDescription(0);
	}
	*TargetDescription = MoveTemp(MD);
	Target->CommitMeshDescription(0);
	Target->Build(false);
	Target->PostEditChange();
	Target->MarkPackageDirty();

	if (S.bSaveAfterAnalyze)
	{
		UEditorLoadingAndSavingUtils::SavePackages({ Target->GetOutermost() }, /*bOnlyDirty*/ false);
	}

	Out.OutputMesh = Target;
	Out.bSuccess = true;
	Out.Message = FString::Printf(TEXT("%d windows (%d square, %d portrait, %d landscape, %d storefront), %d skipped, %d floors -> %s"),
		Out.Windows.Num(), Out.SquareCount, Out.PortraitCount, Out.LandscapeCount, Out.StorefrontCount,
		Out.Skipped.Num(), Out.FloorCount, *Target->GetPathName());
	UE_LOG(LogParallaxWindow, Log, TEXT("  %s"), *Out.Message);
	for (const FString& Warning : Out.Warnings)
	{
		UE_LOG(LogParallaxWindow, Warning, TEXT("  %s"), *Warning);
	}
	return Out;
}

TArray<FParallaxAnalyzeSummary> FParallaxWindowAnalyzer::AnalyzeAssetsWithFeedback(const TArray<FAssetData>& Assets)
{
	using namespace ParallaxWindowAnalyzerPrivate;

	TArray<FParallaxAnalyzeSummary> Results;
	TArray<UStaticMesh*> Meshes;
	for (const FAssetData& Asset : Assets)
	{
		if (Asset.IsInstanceOf(UStaticMesh::StaticClass()))
		{
			if (UStaticMesh* Mesh = Cast<UStaticMesh>(Asset.GetAsset()))
			{
				Meshes.Add(Mesh);
			}
		}
	}

	FMessageLog Log(MessageLogName);
	if (Meshes.Num() == 0)
	{
		Log.Warning(LOCTEXT("NoMesh", "Select one or more static meshes in the Content Browser first."));
		Log.Notify(LOCTEXT("NoMeshNotify", "Parallax Window Tool: no static mesh selected."), EMessageSeverity::Warning, true);
		return Results;
	}

	const UParallaxWindowSettings* Settings = GetDefault<UParallaxWindowSettings>();
	Log.NewPage(LOCTEXT("PageTitle", "Analyze"));

	FScopedSlowTask Task(static_cast<float>(Meshes.Num()), LOCTEXT("Analyzing", "Analyzing parallax windows..."));
	Task.MakeDialog(/*bShowCancelButton*/ false);

	int32 Failures = 0;
	int32 TotalSkipped = 0;
	for (UStaticMesh* Mesh : Meshes)
	{
		Task.EnterProgressFrame(1.f, FText::Format(LOCTEXT("AnalyzingMesh", "Analyzing {0}"), FText::FromString(Mesh->GetName())));
		FParallaxAnalyzeSummary Summary = AnalyzeStaticMesh(Mesh, *Settings);

		const FText Header = FText::FromString(FString::Printf(TEXT("%s: %s"), *Mesh->GetName(), *Summary.Message));
		if (Summary.bSuccess)
		{
			Log.Info(Header);
		}
		else
		{
			Log.Error(Header);
			++Failures;
		}
		for (const FParallaxSkippedWindow& Skip : Summary.Skipped)
		{
			Log.Warning(FText::FromString(FString::Printf(TEXT("%s: skipped glass at (%.0f, %.0f, %.0f): %s"),
				*Mesh->GetName(), Skip.Center.X, Skip.Center.Y, Skip.Center.Z, *Skip.Reason)));
		}
		for (const FString& Warning : Summary.Warnings)
		{
			Log.Warning(FText::FromString(FString::Printf(TEXT("%s: %s"), *Mesh->GetName(), *Warning)));
		}
		TotalSkipped += Summary.Skipped.Num();
		Results.Add(MoveTemp(Summary));
	}

	const FText Note = FText::Format(LOCTEXT("Done", "Parallax Window Tool: analyzed {0} mesh(es), {1} failed, {2} glass component(s) skipped."),
		FText::AsNumber(Meshes.Num()), FText::AsNumber(Failures), FText::AsNumber(TotalSkipped));
	Log.Notify(Note, EMessageSeverity::Info, true);
	return Results;
}

FString FParallaxWindowAnalyzer::FormatSummary(const FParallaxAnalyzeSummary& Summary)
{
	FString Text;
	Text += FString::Printf(TEXT("%s  %s\n"), Summary.bSuccess ? TEXT("[OK]") : TEXT("[FAILED]"), *Summary.SourceMeshPath);
	Text += Summary.Message + TEXT("\n");
	if (Summary.bSuccess)
	{
		Text += FString::Printf(TEXT("Glass components: %d   Windows: %d   Skipped: %d   Floors: %d   %s\n"),
			Summary.GlassComponentCount, Summary.Windows.Num(), Summary.Skipped.Num(), Summary.FloorCount,
			Summary.bCreatedNewAsset ? TEXT("(new asset)") : TEXT("(updated existing asset)"));
		Text += FString::Printf(TEXT("  Square %d | Portrait %d | Landscape %d | Storefront %d\n"),
			Summary.SquareCount, Summary.PortraitCount, Summary.LandscapeCount, Summary.StorefrontCount);
	}
	for (const FParallaxSkippedWindow& Skip : Summary.Skipped)
	{
		Text += FString::Printf(TEXT("  skipped #%d at (%.0f, %.0f, %.0f): %s\n"), Skip.ComponentIndex, Skip.Center.X, Skip.Center.Y, Skip.Center.Z, *Skip.Reason);
	}
	for (const FString& Warning : Summary.Warnings)
	{
		Text += TEXT("  warning: ") + Warning + TEXT("\n");
	}
	return Text;
}

#undef LOCTEXT_NAMESPACE
