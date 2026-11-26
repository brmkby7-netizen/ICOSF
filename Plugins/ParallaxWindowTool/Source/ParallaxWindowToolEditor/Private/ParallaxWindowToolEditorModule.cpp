#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"

#include "ParallaxWindowAnalyzer.h"
#include "ParallaxWindowMaterialBuilder.h"
#include "SParallaxWindowPanel.h"

#include "ContentBrowserMenuContexts.h"
#include "HAL/IConsoleManager.h"
#include "Engine/StaticMesh.h"
#include "Framework/Docking/TabManager.h"
#include "MessageLogModule.h"
#include "Styling/AppStyle.h"
#include "ToolMenus.h"
#include "Widgets/Docking/SDockTab.h"

#define LOCTEXT_NAMESPACE "FParallaxWindowToolEditorModule"

namespace ParallaxWindowToolEditor
{
	static const FName TabName(TEXT("ParallaxWindowTool"));
	static const FName MessageLogName(TEXT("ParallaxWindowTool"));
}

class FParallaxWindowToolEditorModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		using namespace ParallaxWindowToolEditor;

		FGlobalTabmanager::Get()->RegisterNomadTabSpawner(TabName,
			FOnSpawnTab::CreateRaw(this, &FParallaxWindowToolEditorModule::SpawnTab))
			.SetDisplayName(LOCTEXT("TabTitle", "Parallax Window Tool"))
			.SetTooltipText(LOCTEXT("TabTooltip", "Turn building glass into parallax interior windows."))
			.SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), TEXT("ClassIcon.StaticMesh")));

		// Console command (` key): ParallaxWindowTool
		OpenCommand = IConsoleManager::Get().RegisterConsoleCommand(
			TEXT("ParallaxWindowTool"),
			TEXT("Open the Parallax Window Tool panel."),
			FConsoleCommandDelegate::CreateLambda([]() { FGlobalTabmanager::Get()->TryInvokeTab(ParallaxWindowToolEditor::TabName); }),
			ECVF_Default);

		FMessageLogModule& MessageLog = FModuleManager::LoadModuleChecked<FMessageLogModule>(TEXT("MessageLog"));
		FMessageLogInitializationOptions LogOptions;
		LogOptions.bShowPages = true;
		LogOptions.bAllowClear = true;
		MessageLog.RegisterLogListing(MessageLogName, LOCTEXT("LogName", "Parallax Window Tool"), LogOptions);

		UToolMenus::RegisterStartupCallback(FSimpleMulticastDelegate::FDelegate::CreateRaw(this, &FParallaxWindowToolEditorModule::RegisterMenus));
	}

	virtual void ShutdownModule() override
	{
		using namespace ParallaxWindowToolEditor;

		UToolMenus::UnRegisterStartupCallback(this);
		UToolMenus::UnregisterOwner(this);

		if (OpenCommand)
		{
			IConsoleManager::Get().UnregisterConsoleObject(OpenCommand);
			OpenCommand = nullptr;
		}

		if (FSlateApplication::IsInitialized())
		{
			FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TabName);
		}
		if (FModuleManager::Get().IsModuleLoaded(TEXT("MessageLog")))
		{
			FModuleManager::GetModuleChecked<FMessageLogModule>(TEXT("MessageLog")).UnregisterLogListing(MessageLogName);
		}
	}

private:
	IConsoleObject* OpenCommand = nullptr;

	static void OpenPanel()
	{
		FGlobalTabmanager::Get()->TryInvokeTab(ParallaxWindowToolEditor::TabName);
	}

	TSharedRef<SDockTab> SpawnTab(const FSpawnTabArgs& Args)
	{
		return SNew(SDockTab)
			.TabRole(ETabRole::NomadTab)
			[
				SNew(SParallaxWindowPanel)
			];
	}

	void RegisterMenus()
	{
		FToolMenuOwnerScoped OwnerScoped(this);

		const FSlateIcon Icon(FAppStyle::GetAppStyleSetName(), TEXT("ClassIcon.StaticMesh"));
		const FUIAction OpenAction(FExecuteAction::CreateStatic(&FParallaxWindowToolEditorModule::OpenPanel));

		// Tools > Parallax Window Tool, and Window > Parallax Window Tool
		for (const TCHAR* MenuName : { TEXT("LevelEditor.MainMenu.Tools"), TEXT("LevelEditor.MainMenu.Window") })
		{
			if (UToolMenu* Menu = UToolMenus::Get()->ExtendMenu(MenuName))
			{
				FToolMenuSection& Section = Menu->FindOrAddSection(TEXT("ParallaxWindowTool"), LOCTEXT("MenuSection", "Parallax Window Tool"));
				Section.AddMenuEntry(
					TEXT("OpenParallaxWindowTool"),
					LOCTEXT("OpenTab", "Parallax Window Tool"),
					LOCTEXT("OpenTabTip", "Open the Parallax Window Tool panel."),
					Icon,
					OpenAction);
			}
		}

		// Level editor toolbar button
		if (UToolMenu* Toolbar = UToolMenus::Get()->ExtendMenu(TEXT("LevelEditor.LevelEditorToolBar.User")))
		{
			FToolMenuSection& Section = Toolbar->FindOrAddSection(TEXT("ParallaxWindowTool"));
			Section.AddEntry(FToolMenuEntry::InitToolBarButton(
				TEXT("OpenParallaxWindowToolButton"),
				OpenAction,
				LOCTEXT("ToolbarLabel", "Parallax Windows"),
				LOCTEXT("OpenTabTip2", "Open the Parallax Window Tool panel."),
				Icon));
		}

		// Right-click a static mesh in the Content Browser > Analyze Parallax Windows
		if (UToolMenu* AssetMenu = UToolMenus::Get()->ExtendMenu(TEXT("ContentBrowser.AssetContextMenu.StaticMesh")))
		{
			FToolMenuSection& Section = AssetMenu->FindOrAddSection(TEXT("GetAssetActions"));

			FToolUIAction Action;
			Action.ExecuteAction = FToolMenuExecuteAction::CreateLambda([](const FToolMenuContext& Context)
			{
				if (const UContentBrowserAssetContextMenuContext* MenuContext = Context.FindContext<UContentBrowserAssetContextMenuContext>())
				{
					FParallaxWindowAnalyzer::AnalyzeAssetsWithFeedback(MenuContext->SelectedAssets);
				}
			});

			Section.AddMenuEntry(
				TEXT("AnalyzeParallaxWindows"),
				LOCTEXT("AnalyzeEntry", "Analyze Parallax Windows"),
				LOCTEXT("AnalyzeEntryTip", "Detect window panes in the glass slot, write parallax UVs and save a new '_Parallax' mesh."),
				FSlateIcon(FAppStyle::GetAppStyleSetName(), TEXT("ClassIcon.StaticMesh")),
				FToolUIActionChoice(Action));

			FToolUIAction AssignAction;
			AssignAction.ExecuteAction = FToolMenuExecuteAction::CreateLambda([](const FToolMenuContext& Context)
			{
				if (const UContentBrowserAssetContextMenuContext* MenuContext = Context.FindContext<UContentBrowserAssetContextMenuContext>())
				{
					TArray<UStaticMesh*> Meshes;
					for (const FAssetData& Asset : MenuContext->SelectedAssets)
					{
						if (UStaticMesh* Mesh = Cast<UStaticMesh>(Asset.GetAsset()))
						{
							Meshes.Add(Mesh);
						}
					}
					FString Report;
					FParallaxWindowMaterialBuilder::AssignClassMaterials(Meshes, Report);
					UE_LOG(LogTemp, Log, TEXT("Parallax Window Tool:\n%s"), *Report);
				}
			});

			Section.AddMenuEntry(
				TEXT("AssignParallaxInstances"),
				LOCTEXT("AssignEntry", "Assign Parallax Instances"),
				LOCTEXT("AssignEntryTip", "Put the Square / Portrait / Landscape / Storefront material instances into this processed mesh's Parallax_* slots."),
				FSlateIcon(FAppStyle::GetAppStyleSetName(), TEXT("ClassIcon.MaterialInstanceConstant")),
				FToolUIActionChoice(AssignAction));
		}
	}
};

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FParallaxWindowToolEditorModule, ParallaxWindowToolEditor)
