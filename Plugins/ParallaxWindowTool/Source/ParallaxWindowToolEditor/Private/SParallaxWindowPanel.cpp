#include "SParallaxWindowPanel.h"
#include "ParallaxWindowAnalyzer.h"
#include "ParallaxWindowMaterialBuilder.h"
#include "ParallaxWindowSettings.h"

#include "AssetRegistry/AssetData.h"
#include "ContentBrowserModule.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "Engine/Selection.h"
#include "Components/StaticMeshComponent.h"
#include "GameFramework/Actor.h"
#include "Engine/Texture2D.h"
#include "IContentBrowserSingleton.h"
#include "IDetailsView.h"
#include "Modules/ModuleManager.h"
#include "PropertyEditorModule.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Input/SSpinBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/Layout/SWrapBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"
#include "Styling/AppStyle.h"
#include "Styling/CoreStyle.h"

#define LOCTEXT_NAMESPACE "SParallaxWindowPanel"

void SParallaxWindowPanel::Construct(const FArguments& InArgs)
{
	using namespace ParallaxWindowParams;

	FPropertyEditorModule& PropertyEditor = FModuleManager::LoadModuleChecked<FPropertyEditorModule>(TEXT("PropertyEditor"));
	FDetailsViewArgs Args;
	Args.bHideSelectionTip = true;
	Args.bAllowSearch = true;
	Args.NameAreaSettings = FDetailsViewArgs::HideNameArea;
	DetailsView = PropertyEditor.CreateDetailView(Args);
	DetailsView->SetObject(GetMutableDefault<UParallaxWindowSettings>());

	ReportText = LOCTEXT("NoReport", "1. Build / Update Materials once per project.\n2. Select imported building meshes in the Content Browser and press Analyze.\n3. Place the _Parallax meshes and press Randomize Seeds.");

	auto Button = [this](const FText& Label, const FText& Tip, FReply (SParallaxWindowPanel::*Handler)()) -> TSharedRef<SWidget>
	{
		return SNew(SBox).Padding(2.f)
		[
			SNew(SButton).Text(Label).ToolTipText(Tip).OnClicked(this, Handler)
		];
	};
	auto PoolButton = [this](const FText& Label, EParallaxTexturePool Pool) -> TSharedRef<SWidget>
	{
		return SNew(SBox).Padding(2.f)
		[
			SNew(SButton)
			.Text(Label)
			.ToolTipText(LOCTEXT("AddPoolTip", "Add the textures selected in the Content Browser to this pool."))
			.OnClicked(this, &SParallaxWindowPanel::OnAddSelectedTextures, Pool)
		];
	};

	TSharedRef<SWidget> Controls =
		SNew(SScrollBox)
		+ SScrollBox::Slot()
		[
			SNew(SVerticalBox)

			// 1. Analyze
			+ SVerticalBox::Slot().AutoHeight()
			[
				MakeSection(LOCTEXT("S1", "1. Analyze"),
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot().AutoWidth()
						[
							SNew(SBox).Padding(2.f)
							[
								SNew(SButton)
								.Text(LOCTEXT("Analyze", "Analyze Selected Mesh"))
								.ToolTipText(LOCTEXT("AnalyzeTip", "Detect window panes in the glass slot of the selected static mesh(es) and save '<mesh>_Parallax'."))
								.IsEnabled(this, &SParallaxWindowPanel::HasMeshSelection)
								.OnClicked(this, &SParallaxWindowPanel::OnAnalyze)
							]
						]
						+ SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(6.f, 0.f)
						[
							SNew(STextBlock).Text(this, &SParallaxWindowPanel::GetSelectionText)
						]
					])
			]

			// 2. Materials
			+ SVerticalBox::Slot().AutoHeight()
			[
				MakeSection(LOCTEXT("S2", "2. Materials"),
					SNew(SWrapBox).UseAllottedSize(true)
					+ SWrapBox::Slot()[Button(LOCTEXT("Build", "Build / Update Materials"),
						LOCTEXT("BuildTip", "Create or rebuild M_ParallaxWindow (from Shaders/ParallaxWindowCustomNode.hlsl), MPC_ParallaxCity and the four class instances."),
						&SParallaxWindowPanel::OnBuildMaterials)]
					+ SWrapBox::Slot()[Button(LOCTEXT("Assign", "Assign Instances to Selected Meshes"),
						LOCTEXT("AssignTip", "Put the class instances into the Parallax_* slots of the selected processed meshes."),
						&SParallaxWindowPanel::OnAssignMaterials)])
			]

			// 3. Texture library
			+ SVerticalBox::Slot().AutoHeight()
			[
				MakeSection(LOCTEXT("S3", "3. Texture Library"),
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight().Padding(2.f)
					[
						SNew(STextBlock).Text(this, &SParallaxWindowPanel::GetLibraryText)
					]
					+ SVerticalBox::Slot().AutoHeight()
					[
						SNew(SWrapBox).UseAllottedSize(true)
						+ SWrapBox::Slot()[Button(LOCTEXT("Library", "Create / Open Library"),
							LOCTEXT("LibraryTip", "Open the texture library data asset (created in the tool folder if missing)."),
							&SParallaxWindowPanel::OnCreateOrOpenLibrary)]
						+ SWrapBox::Slot()[Button(LOCTEXT("Rebuild", "Rebuild Texture Arrays"),
							LOCTEXT("RebuildTip", "Resize every pool into a Texture 2D Array and assign it to the matching instance."),
							&SParallaxWindowPanel::OnRebuildArrays)]
					]
					+ SVerticalBox::Slot().AutoHeight()
					[
						SNew(SWrapBox).UseAllottedSize(true)
						+ SWrapBox::Slot()[PoolButton(LOCTEXT("AddSquare", "+ Square"), EParallaxTexturePool::Square)]
						+ SWrapBox::Slot()[PoolButton(LOCTEXT("AddPortrait", "+ Portrait"), EParallaxTexturePool::Portrait)]
						+ SWrapBox::Slot()[PoolButton(LOCTEXT("AddLandscape", "+ Landscape"), EParallaxTexturePool::Landscape)]
						+ SWrapBox::Slot()[PoolButton(LOCTEXT("AddStorefront", "+ Storefront"), EParallaxTexturePool::Storefront)]
						+ SWrapBox::Slot()[PoolButton(LOCTEXT("AddForeground", "+ Storefront Foreground"), EParallaxTexturePool::StorefrontForeground)]
					])
			]

			// 4. Level
			+ SVerticalBox::Slot().AutoHeight()
			[
				MakeSection(LOCTEXT("S4", "4. Level"),
					Button(LOCTEXT("Seeds", "Randomize Seeds in Level"),
						LOCTEXT("SeedsTip", "Give every placed parallax building its own seed (Custom Primitive Data 0), so copies of the same mesh light up differently. Undoable."),
						&SParallaxWindowPanel::OnRandomizeSeeds))
			]

			// 5. City controls
			+ SVerticalBox::Slot().AutoHeight()
			[
				MakeSection(LOCTEXT("S5", "5. City Controls (MPC_ParallaxCity)"),
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()[MakeCitySlider(LOCTEXT("DayNight", "Day / Night"), CityDayNight)]
					+ SVerticalBox::Slot().AutoHeight()[MakeCitySlider(LOCTEXT("LitPercent", "Lit Percent"), CityLitPercent)]
					+ SVerticalBox::Slot().AutoHeight()[MakeCitySlider(LOCTEXT("WarmRatio", "Warm Ratio"), CityWarmRatio)])
			]
		];

	ChildSlot
	[
		SNew(SSplitter)
		.Orientation(Orient_Vertical)

		+ SSplitter::Slot().Value(0.42f)
		[
			Controls
		]

		+ SSplitter::Slot().Value(0.38f)
		[
			DetailsView.ToSharedRef()
		]

		+ SSplitter::Slot().Value(0.2f)
		[
			SNew(SBox).Padding(6.f)
			[
				SNew(SMultiLineEditableTextBox)
				.IsReadOnly(true)
				.AutoWrapText(false)
				.Text(this, &SParallaxWindowPanel::GetReportText)
			]
		]
	];
}

TSharedRef<SWidget> SParallaxWindowPanel::MakeSection(const FText& Title, const TSharedRef<SWidget>& Content)
{
	return SNew(SBox).Padding(6.f, 4.f)
	[
		SNew(SBorder)
		.BorderImage(FAppStyle::GetBrush(TEXT("ToolPanel.GroupBorder")))
		.Padding(6.f)
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 4.f)
			[
				SNew(STextBlock).Text(Title).Font(FCoreStyle::GetDefaultFontStyle("Bold", 10))
			]
			+ SVerticalBox::Slot().AutoHeight()
			[
				Content
			]
		]
	];
}

TSharedRef<SWidget> SParallaxWindowPanel::MakeCitySlider(const FText& Label, FName Parameter)
{
	return SNew(SHorizontalBox)
		.IsEnabled_Lambda([]() { return FParallaxWindowMaterialBuilder::GetCityCollection(false) != nullptr; })
		.ToolTipText(LOCTEXT("CityTip", "Stored as the Material Parameter Collection default. At runtime drive it with 'Set Scalar Parameter Value' on MPC_ParallaxCity. Disabled until Build / Update Materials has run."))
		+ SHorizontalBox::Slot().FillWidth(0.35f).VAlign(VAlign_Center).Padding(2.f)
		[
			SNew(STextBlock).Text(Label)
		]
		+ SHorizontalBox::Slot().FillWidth(0.65f).Padding(2.f)
		[
			SNew(SSpinBox<float>)
			.MinValue(0.f)
			.MaxValue(1.f)
			.MinSliderValue(0.f)
			.MaxSliderValue(1.f)
			.Delta(0.01f)
			.Value_Lambda([Parameter]() { return FParallaxWindowMaterialBuilder::GetCityControl(Parameter); })
			.OnValueChanged_Lambda([Parameter](float Value) { FParallaxWindowMaterialBuilder::SetCityControl(Parameter, Value); })
		];
}

TArray<FAssetData> SParallaxWindowPanel::GetSelectedAssetsOfClass(UClass* Class) const
{
	TArray<FAssetData> Selected;
	FContentBrowserModule& ContentBrowser = FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
	ContentBrowser.Get().GetSelectedAssets(Selected);
	Selected.RemoveAll([Class](const FAssetData& Asset) { return !Asset.IsInstanceOf(Class); });
	return Selected;
}

TArray<FAssetData> SParallaxWindowPanel::GetSelectedStaticMeshes() const
{
	TArray<FAssetData> Result = GetSelectedAssetsOfClass(UStaticMesh::StaticClass());
	if (Result.Num() > 0 || !GEditor)
	{
		return Result;
	}

	// Nothing in the Content Browser: use the meshes of the actors selected in the viewport.
	TSet<UStaticMesh*> Meshes;
	for (FSelectionIterator It(GEditor->GetSelectedActorIterator()); It; ++It)
	{
		if (const AActor* Actor = Cast<AActor>(*It))
		{
			TInlineComponentArray<UStaticMeshComponent*> Components(Actor);
			for (const UStaticMeshComponent* Component : Components)
			{
				if (UStaticMesh* Mesh = Component ? Component->GetStaticMesh() : nullptr)
				{
					Meshes.Add(Mesh);
				}
			}
		}
	}
	for (UStaticMesh* Mesh : Meshes)
	{
		Result.Add(FAssetData(Mesh));
	}
	return Result;
}

bool SParallaxWindowPanel::HasMeshSelection() const
{
	return GetSelectedStaticMeshes().Num() > 0;
}

FText SParallaxWindowPanel::GetSelectionText() const
{
	const TArray<FAssetData> Selected = GetSelectedStaticMeshes();
	if (Selected.Num() == 0)
	{
		return LOCTEXT("NoSelection", "Select a building in the viewport or a static mesh in the Content Browser.");
	}
	if (Selected.Num() == 1)
	{
		return FText::FromName(Selected[0].AssetName);
	}
	return FText::Format(LOCTEXT("MultiSelection", "{0} static meshes selected"), FText::AsNumber(Selected.Num()));
}

FText SParallaxWindowPanel::GetLibraryText() const
{
	const UParallaxWindowSettings* Settings = GetDefault<UParallaxWindowSettings>();
	if (!Settings->TextureLibrary.IsValid())
	{
		return LOCTEXT("NoLibrary", "No library yet. Placeholder rooms are used until you add textures.");
	}
	UParallaxTextureLibrary* Library = Cast<UParallaxTextureLibrary>(Settings->TextureLibrary.ResolveObject());
	if (!Library)
	{
		return FText::FromString(Settings->TextureLibrary.GetAssetName());
	}
	return FText::Format(LOCTEXT("LibraryCounts", "{0}: Square {1} | Portrait {2} | Landscape {3} | Storefront {4} | Foreground {5}"),
		FText::FromString(Library->GetName()),
		FText::AsNumber(Library->SquareTextures.Num()), FText::AsNumber(Library->PortraitTextures.Num()),
		FText::AsNumber(Library->LandscapeTextures.Num()), FText::AsNumber(Library->StorefrontTextures.Num()),
		FText::AsNumber(Library->StorefrontForegroundTextures.Num()));
}

void SParallaxWindowPanel::SetReport(const FString& Report)
{
	ReportText = FText::FromString(Report.IsEmpty() ? TEXT("Done.") : Report);
}

FReply SParallaxWindowPanel::OnAnalyze()
{
	const TArray<FParallaxAnalyzeSummary> Results = FParallaxWindowAnalyzer::AnalyzeAssetsWithFeedback(GetSelectedStaticMeshes());
	FString Report;
	for (const FParallaxAnalyzeSummary& Summary : Results)
	{
		Report += FParallaxWindowAnalyzer::FormatSummary(Summary) + TEXT("\n");
	}
	SetReport(Report.IsEmpty() ? TEXT("Nothing analyzed.") : Report);
	return FReply::Handled();
}

FReply SParallaxWindowPanel::OnBuildMaterials()
{
	FString Report;
	FParallaxWindowMaterialBuilder::BuildMaterials(Report);
	SetReport(Report);
	return FReply::Handled();
}

FReply SParallaxWindowPanel::OnAssignMaterials()
{
	TArray<UStaticMesh*> Meshes;
	for (const FAssetData& Asset : GetSelectedStaticMeshes())
	{
		if (UStaticMesh* Mesh = Cast<UStaticMesh>(Asset.GetAsset()))
		{
			Meshes.Add(Mesh);
		}
	}
	FString Report;
	if (Meshes.Num() == 0)
	{
		Report = TEXT("Select processed (_Parallax) meshes in the Content Browser first.");
	}
	else
	{
		FParallaxWindowMaterialBuilder::AssignClassMaterials(Meshes, Report);
	}
	SetReport(Report);
	return FReply::Handled();
}

FReply SParallaxWindowPanel::OnCreateOrOpenLibrary()
{
	if (UParallaxTextureLibrary* Library = FParallaxWindowMaterialBuilder::CreateTextureLibrary())
	{
		if (GEditor)
		{
			GEditor->GetEditorSubsystem<UAssetEditorSubsystem>()->OpenEditorForAsset(Library);
		}
		SetReport(FString::Printf(TEXT("Texture library: %s\nAdd one-point perspective room images to each pool (or select textures and use the + buttons), then Rebuild Texture Arrays."), *Library->GetPathName()));
	}
	return FReply::Handled();
}

FReply SParallaxWindowPanel::OnAddSelectedTextures(EParallaxTexturePool Pool)
{
	UParallaxTextureLibrary* Library = FParallaxWindowMaterialBuilder::CreateTextureLibrary();
	if (!Library)
	{
		return FReply::Handled();
	}

	int32 Added = 0;
	Library->Modify();
	TArray<TObjectPtr<UTexture2D>>& Textures = Library->GetPool(Pool);
	for (const FAssetData& Asset : GetSelectedAssetsOfClass(UTexture2D::StaticClass()))
	{
		if (UTexture2D* Texture = Cast<UTexture2D>(Asset.GetAsset()))
		{
			if (!Textures.Contains(Texture))
			{
				Textures.Add(Texture);
				++Added;
			}
		}
	}
	Library->MarkPackageDirty();
	SetReport(FString::Printf(TEXT("Added %d texture(s) to the %s pool (%d total). Press Rebuild Texture Arrays when done."),
		Added, UParallaxTextureLibrary::GetPoolName(Pool), Textures.Num()));
	return FReply::Handled();
}

FReply SParallaxWindowPanel::OnRebuildArrays()
{
	FString Report;
	FParallaxWindowMaterialBuilder::RebuildTextureArrays(FParallaxWindowMaterialBuilder::CreateTextureLibrary(), Report);
	SetReport(Report);
	return FReply::Handled();
}

FReply SParallaxWindowPanel::OnRandomizeSeeds()
{
	FString Report;
	FParallaxWindowMaterialBuilder::RandomizeSeedsInLevel(Report);
	SetReport(Report);
	return FReply::Handled();
}

#undef LOCTEXT_NAMESPACE
