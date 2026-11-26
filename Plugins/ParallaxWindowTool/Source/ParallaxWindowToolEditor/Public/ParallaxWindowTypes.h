#pragma once

#include "CoreMinimal.h"
#include "ParallaxWindowTypes.generated.h"

class UStaticMesh;

/** Shape class of a window. Each class gets its own material slot / section. */
UENUM(BlueprintType)
enum class EParallaxWindowClass : uint8
{
	Square,
	Portrait,
	Landscape,
	Storefront,
};

namespace ParallaxWindow
{
	inline constexpr int32 NumClasses = 4;

	/** Material slot name written into the processed mesh for each class. Stable, so instances can be bulk-assigned. */
	inline FName GetClassSlotName(EParallaxWindowClass Class)
	{
		switch (Class)
		{
		case EParallaxWindowClass::Square:     return FName(TEXT("Parallax_Square"));
		case EParallaxWindowClass::Portrait:   return FName(TEXT("Parallax_Portrait"));
		case EParallaxWindowClass::Landscape:  return FName(TEXT("Parallax_Landscape"));
		case EParallaxWindowClass::Storefront: return FName(TEXT("Parallax_Storefront"));
		}
		return NAME_None;
	}

	inline const TCHAR* GetClassDisplayName(EParallaxWindowClass Class)
	{
		switch (Class)
		{
		case EParallaxWindowClass::Square:     return TEXT("Square");
		case EParallaxWindowClass::Portrait:   return TEXT("Portrait");
		case EParallaxWindowClass::Landscape:  return TEXT("Landscape");
		case EParallaxWindowClass::Storefront: return TEXT("Storefront");
		}
		return TEXT("?");
	}
}

/** One accepted window (one connected component of the glass slot). Positions are in mesh local space (cm). */
USTRUCT(BlueprintType)
struct FParallaxWindowRecord
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 WindowIndex = INDEX_NONE;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") EParallaxWindowClass Class = EParallaxWindowClass::Square;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") FVector Center = FVector::ZeroVector;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") FVector Normal = FVector::ZeroVector;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") FVector Right = FVector::ZeroVector;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") FVector Up = FVector::ZeroVector;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") float Width = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") float Height = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") float AspectRatio = 0.f;
	/** Height of the window's lowest point above the mesh bottom (or above Z=0, see settings). */
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") float BottomHeight = 0.f;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 FloorIndex = 0;
	/** Hash in [0,1), written to the window data UV channel X. */
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") float RandomId = 0.f;
	/** Glass area / bounding rectangle area. */
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") float Rectangularity = 0.f;
};

/** A glass component that was left as plain glass, with the reason. */
USTRUCT(BlueprintType)
struct FParallaxSkippedWindow
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 ComponentIndex = INDEX_NONE;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") FVector Center = FVector::ZeroVector;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") FString Reason;
};

/** Result of analyzing one static mesh. */
USTRUCT(BlueprintType)
struct FParallaxAnalyzeSummary
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") bool bSuccess = false;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") FString Message;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") FString SourceMeshPath;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") TObjectPtr<UStaticMesh> OutputMesh = nullptr;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") bool bCreatedNewAsset = false;

	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 GlassComponentCount = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 SquareCount = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 PortraitCount = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 LandscapeCount = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 StorefrontCount = 0;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") int32 FloorCount = 0;

	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") TArray<FParallaxWindowRecord> Windows;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") TArray<FParallaxSkippedWindow> Skipped;
	UPROPERTY(BlueprintReadOnly, Category = "Parallax Window") TArray<FString> Warnings;
};
