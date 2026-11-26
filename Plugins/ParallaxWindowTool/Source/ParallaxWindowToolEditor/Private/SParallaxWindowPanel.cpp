#include "SParallaxWindowPanel.h"
#include "ParallaxWindowAnalyzer.h"
#include "ParallaxWindowSettings.h"

#include "AssetRegistry/AssetData.h"
#include "ContentBrowserModule.h"
#include "IContentBrowserSingleton.h"
#include "Engine/StaticMesh.h"
#include "IDetailsView.h"
#include "Modules/ModuleManager.h"
#include "PropertyEditorModule.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SMultiLineEditableTextBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SSplitter.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/Text/STextBlock.h"

#define LOCTEXT_NAMESPACE "SParallaxWindowPanel"

void SParallaxWindowPanel::Construct(const FArguments& InArgs)
{
	FPropertyEditorModule& PropertyEditor = FModuleManager::LoadModuleChecked<FPropertyEditorModule>(TEXT("PropertyEditor"));
	FDetailsViewArgs Args;
	Args.bHideSelectionTip = true;
	Args.bAllowSearch = true;
	Args.NameAreaSettings = FDetailsViewArgs::HideNameArea;
	DetailsView = PropertyEditor.CreateDetailView(Args);
	DetailsView->SetObject(GetMutableDefault<UParallaxWindowSettings>());

	ReportText = LOCTEXT("NoReport", "Select a static mesh in the Content Browser and press Analyze.");

	ChildSlot
	[
		SNew(SVerticalBox)

		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(8.f)
		[
			SNew(STextBlock)
			.AutoWrapText(true)
			.Text(LOCTEXT("Intro",
				"Step 1 - Analyze: finds each window pane in the glass slot, writes per-window UVs "
				"(UV0 = 0-1 per window, window data channel = random ID / floor index), sorts windows into "
				"Square / Portrait / Landscape / Storefront slots and saves a new '<mesh>_Parallax' asset. "
				"The imported mesh is never changed."))
		]

		+ SVerticalBox::Slot()
		.FillHeight(1.f)
		[
			SNew(SSplitter)
			.Orientation(Orient_Vertical)

			+ SSplitter::Slot()
			.Value(0.6f)
			[
				DetailsView.ToSharedRef()
			]

			+ SSplitter::Slot()
			.Value(0.4f)
			[
				SNew(SVerticalBox)

				+ SVerticalBox::Slot()
				.AutoHeight()
				.Padding(8.f, 8.f, 8.f, 4.f)
				[
					SNew(SHorizontalBox)

					+ SHorizontalBox::Slot()
					.AutoWidth()
					[
						SNew(SButton)
						.Text(LOCTEXT("Analyze", "Analyze Selected Mesh"))
						.ToolTipText(LOCTEXT("AnalyzeTip", "Analyze the static mesh(es) selected in the Content Browser."))
						.IsEnabled(this, &SParallaxWindowPanel::HasSelection)
						.OnClicked(this, &SParallaxWindowPanel::OnAnalyzeClicked)
					]

					+ SHorizontalBox::Slot()
					.FillWidth(1.f)
					.VAlign(VAlign_Center)
					.Padding(8.f, 0.f)
					[
						SNew(STextBlock)
						.Text(this, &SParallaxWindowPanel::GetSelectionText)
					]
				]

				+ SVerticalBox::Slot()
				.FillHeight(1.f)
				.Padding(8.f, 4.f, 8.f, 8.f)
				[
					SNew(SMultiLineEditableTextBox)
					.IsReadOnly(true)
					.AutoWrapText(false)
					.Text(this, &SParallaxWindowPanel::GetReportText)
				]
			]
		]
	];
}

TArray<FAssetData> SParallaxWindowPanel::GetSelectedStaticMeshes() const
{
	TArray<FAssetData> Selected;
	FContentBrowserModule& ContentBrowser = FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
	ContentBrowser.Get().GetSelectedAssets(Selected);
	Selected.RemoveAll([](const FAssetData& Asset) { return !Asset.IsInstanceOf(UStaticMesh::StaticClass()); });
	return Selected;
}

bool SParallaxWindowPanel::HasSelection() const
{
	return GetSelectedStaticMeshes().Num() > 0;
}

FText SParallaxWindowPanel::GetSelectionText() const
{
	const TArray<FAssetData> Selected = GetSelectedStaticMeshes();
	if (Selected.Num() == 0)
	{
		return LOCTEXT("NoSelection", "No static mesh selected in the Content Browser.");
	}
	if (Selected.Num() == 1)
	{
		return FText::FromName(Selected[0].AssetName);
	}
	return FText::Format(LOCTEXT("MultiSelection", "{0} static meshes selected"), FText::AsNumber(Selected.Num()));
}

FReply SParallaxWindowPanel::OnAnalyzeClicked()
{
	const TArray<FParallaxAnalyzeSummary> Results = FParallaxWindowAnalyzer::AnalyzeAssetsWithFeedback(GetSelectedStaticMeshes());
	FString Report;
	for (const FParallaxAnalyzeSummary& Summary : Results)
	{
		Report += FParallaxWindowAnalyzer::FormatSummary(Summary) + TEXT("\n");
	}
	ReportText = FText::FromString(Report.IsEmpty() ? TEXT("Nothing analyzed.") : Report);
	return FReply::Handled();
}

#undef LOCTEXT_NAMESPACE
