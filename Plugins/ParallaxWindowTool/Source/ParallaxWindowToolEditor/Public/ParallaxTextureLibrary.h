#pragma once

#include "CoreMinimal.h"
#include "Engine/DataAsset.h"
#include "Engine/Texture2D.h"
#include "Engine/Texture2DArray.h"
#include "ParallaxWindowTypes.h"
#include "ParallaxTextureLibrary.generated.h"

/** Texture pools. The four window classes plus the storefront foreground layer. */
UENUM(BlueprintType)
enum class EParallaxTexturePool : uint8
{
	Square,
	Portrait,
	Landscape,
	Storefront,
	StorefrontForeground,
};

/**
 * Room texture library. Fill each pool with one-point perspective interior images
 * (back wall in the middle, floor / ceiling / side walls around it), then press
 * "Rebuild Texture Arrays" in the Parallax Window Tool panel. Each pool is resized
 * (center-cropped, never rotated) into one Texture 2D Array and assigned to the
 * matching material instance.
 *
 * Editor-only data: the generated arrays and material instances are plain engine
 * assets and do not need this plugin at runtime.
 */
UCLASS(BlueprintType)
class PARALLAXWINDOWTOOLEDITOR_API UParallaxTextureLibrary : public UDataAsset
{
	GENERATED_BODY()

public:
	// ------------------------------------------------------------ Pools

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Pools")
	TArray<TObjectPtr<UTexture2D>> SquareTextures;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Pools")
	TArray<TObjectPtr<UTexture2D>> PortraitTextures;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Pools")
	TArray<TObjectPtr<UTexture2D>> LandscapeTextures;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Pools")
	TArray<TObjectPtr<UTexture2D>> StorefrontTextures;

	/** Optional foreground layer for storefronts (shelves, signage). Needs an alpha channel. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Pools")
	TArray<TObjectPtr<UTexture2D>> StorefrontForegroundTextures;

	// ------------------------------------------------------------ Array sizes (all slices of an array must match)

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Sizes", meta = (ClampMin = "64", ClampMax = "8192"))
	FIntPoint SquareSize = FIntPoint(1024, 1024);

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Sizes", meta = (ClampMin = "64", ClampMax = "8192"))
	FIntPoint PortraitSize = FIntPoint(1024, 2048);

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Sizes", meta = (ClampMin = "64", ClampMax = "8192"))
	FIntPoint LandscapeSize = FIntPoint(2048, 1024);

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Sizes", meta = (ClampMin = "64", ClampMax = "8192"))
	FIntPoint StorefrontSize = FIntPoint(2048, 1024);

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Sizes", meta = (ClampMin = "64", ClampMax = "8192"))
	FIntPoint StorefrontForegroundSize = FIntPoint(2048, 1024);

	// ------------------------------------------------------------ Generated (by Rebuild Texture Arrays)

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Generated")
	TObjectPtr<UTexture2DArray> SquareArray;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Generated")
	TObjectPtr<UTexture2DArray> PortraitArray;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Generated")
	TObjectPtr<UTexture2DArray> LandscapeArray;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Generated")
	TObjectPtr<UTexture2DArray> StorefrontArray;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Generated")
	TObjectPtr<UTexture2DArray> StorefrontForegroundArray;

	TArray<TObjectPtr<UTexture2D>>& GetPool(EParallaxTexturePool Pool)
	{
		switch (Pool)
		{
		case EParallaxTexturePool::Square:               return SquareTextures;
		case EParallaxTexturePool::Portrait:             return PortraitTextures;
		case EParallaxTexturePool::Landscape:            return LandscapeTextures;
		case EParallaxTexturePool::Storefront:           return StorefrontTextures;
		case EParallaxTexturePool::StorefrontForeground: return StorefrontForegroundTextures;
		}
		return SquareTextures;
	}

	FIntPoint GetSize(EParallaxTexturePool Pool) const
	{
		switch (Pool)
		{
		case EParallaxTexturePool::Square:               return SquareSize;
		case EParallaxTexturePool::Portrait:             return PortraitSize;
		case EParallaxTexturePool::Landscape:            return LandscapeSize;
		case EParallaxTexturePool::Storefront:           return StorefrontSize;
		case EParallaxTexturePool::StorefrontForeground: return StorefrontForegroundSize;
		}
		return SquareSize;
	}

	TObjectPtr<UTexture2DArray>& GetArray(EParallaxTexturePool Pool)
	{
		switch (Pool)
		{
		case EParallaxTexturePool::Square:               return SquareArray;
		case EParallaxTexturePool::Portrait:             return PortraitArray;
		case EParallaxTexturePool::Landscape:            return LandscapeArray;
		case EParallaxTexturePool::Storefront:           return StorefrontArray;
		case EParallaxTexturePool::StorefrontForeground: return StorefrontForegroundArray;
		}
		return SquareArray;
	}

	static const TCHAR* GetPoolName(EParallaxTexturePool Pool)
	{
		switch (Pool)
		{
		case EParallaxTexturePool::Square:               return TEXT("Square");
		case EParallaxTexturePool::Portrait:             return TEXT("Portrait");
		case EParallaxTexturePool::Landscape:            return TEXT("Landscape");
		case EParallaxTexturePool::Storefront:           return TEXT("Storefront");
		case EParallaxTexturePool::StorefrontForeground: return TEXT("StorefrontForeground");
		}
		return TEXT("?");
	}
};
