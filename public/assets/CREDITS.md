# Asset credits

Every file under `public/assets/` is **CC0 1.0 Universal (public domain)** — no attribution is required, but we credit the sources and artists anyway. No asset carries a real-world brand or logo (the `cement_bag` model has a fictional "SOLIDUS / CEMENT" label designed by Poly Haven; the generator shows only a model number).

- **Poly Haven** — https://polyhaven.com (license: https://polyhaven.com/license, CC0)
- **ambientCG** — https://ambientcg.com (license: https://docs.ambientcg.com/license/, CC0; created by Lennart Demes)

Reproduce / update with `scripts/fetch-assets.sh` (Python 3 + Pillow + numpy + curl). The script also documents the light processing applied: JPEG re-encode (q80–82), ambientCG AO/Roughness/Metalness packed into one ARM map, roughness calibration for a few sets, desaturation of `metal_painted`, night-window emission taken from the lit facade sibling, and HDRI lower hemisphere replaced by a Lambertian ground radiance.

## Textures (PBR sets: color · normal (OpenGL) · arm [+ alpha / emissive])

| Manifest name | Source asset | Res | Tile (m) | Maps | Authors / notes |
|---|---|---|---|---|---|
| `gravel` | [gravel_floor_02](https://polyhaven.com/a/gravel_floor_02) (Poly Haven) | 2K | 2.0 | color, normal, arm | Jenelle van Heerden, Dimitrios Savva; roughness calibrated to 0.85 |
| `dirt` | [brown_mud_dry](https://polyhaven.com/a/brown_mud_dry) (Poly Haven) | 2K | 1.3 | color, normal, arm | Rob Tuytel; roughness calibrated to 0.88 |
| `mud` | [brown_mud_02](https://polyhaven.com/a/brown_mud_02) (Poly Haven) | 2K | 1.3 | color, normal, arm | Rob Tuytel; roughness calibrated to 0.5 |
| `asphalt` | [asphalt_04](https://polyhaven.com/a/asphalt_04) (Poly Haven) | 2K | 4.04 | color, normal, arm | Jenelle van Heerden, Sergej Majboroda |
| `concrete_slab` | [concrete_floor_worn_001](https://polyhaven.com/a/concrete_floor_worn_001) (Poly Haven) | 2K | 3.0 | color, normal, arm | Dimitrios Savva, Rico Cilliers; roughness calibrated to 0.7 |
| `concrete_rough` | [concrete_layers_02](https://polyhaven.com/a/concrete_layers_02) (Poly Haven) | 2K | 2.0 | color, normal, arm | Rob Tuytel |
| `metal_painted` | [Paint004](https://ambientcg.com/a/Paint004) (ambientCG) | 2K | 1.0 | color, normal, arm | ambientCG (Lennart Demes) |
| `grass` | [leafy_grass](https://polyhaven.com/a/leafy_grass) (Poly Haven) | 1K | 2.0 | color, normal, arm | Charlotte Baglioni |
| `asphalt_worn` | [asphalt_02](https://polyhaven.com/a/asphalt_02) (Poly Haven) | 1K | 3.0 | color, normal, arm | Rob Tuytel |
| `sidewalk_pavers` | [concrete_pavement](https://polyhaven.com/a/concrete_pavement) (Poly Haven) | 1K | 1.8 | color, normal, arm | Charlotte Baglioni |
| `concrete_wall` | [concrete_wall_008](https://polyhaven.com/a/concrete_wall_008) (Poly Haven) | 1K | 2.71 | color, normal, arm | Dario Barresi, Charlotte Baglioni |
| `brick_red` | [red_brick](https://polyhaven.com/a/red_brick) (Poly Haven) | 1K | 1.4 | color, normal, arm | Rob Tuytel |
| `brick_old` | [brick_wall_006](https://polyhaven.com/a/brick_wall_006) (Poly Haven) | 1K | 3.0 | color, normal, arm | Jan Burghardt |
| `plaster` | [plastered_wall](https://polyhaven.com/a/plastered_wall) (Poly Haven) | 1K | 2.0 | color, normal, arm | Amal Kumar |
| `rusty_metal` | [rust_coarse_01](https://polyhaven.com/a/rust_coarse_01) (Poly Haven) | 1K | 2.2 | color, normal, arm | Dimitrios Savva, Rico Cilliers |
| `galvanized_metal` | [Metal055A](https://ambientcg.com/a/Metal055A) (ambientCG) | 1K | 1.0 | color, normal, arm | ambientCG (Lennart Demes); roughness calibrated to 0.5 |
| `corrugated_metal` | [corrugated_iron_02](https://polyhaven.com/a/corrugated_iron_02) (Poly Haven) | 1K | 2.7 | color, normal, arm | Jenelle van Heerden, Sergej Majboroda |
| `metal_grating` | [MetalWalkway006](https://ambientcg.com/a/MetalWalkway006) (ambientCG) | 1K | 0.5 | color, normal, arm, alpha | ambientCG (Lennart Demes); roughness calibrated to 0.5 |
| `chainlink` | [Fence003](https://ambientcg.com/a/Fence003) (ambientCG) | 1K | 0.8 | color, normal, arm, alpha | ambientCG (Lennart Demes); roughness calibrated to 0.5 |
| `plywood` | [plywood](https://polyhaven.com/a/plywood) (Poly Haven) | 1K | 0.5 | color, normal, arm | Rob Tuytel |
| `wood_planks` | [wood_planks](https://polyhaven.com/a/wood_planks) (Poly Haven) | 1K | 1.5 | color, normal, arm | Amal Kumar |
| `roof_membrane` | [bitumen](https://polyhaven.com/a/bitumen) (Poly Haven) | 1K | 20.0 | color, normal, arm | Rob Tuytel |
| `tiles_or_stone` | [large_square_pattern_01](https://polyhaven.com/a/large_square_pattern_01) (Poly Haven) | 1K | 3.0 | color, normal, arm | Rob Tuytel |
| `metal_painted_worn` | [PaintedMetal012](https://ambientcg.com/a/PaintedMetal012) (ambientCG) | 1K | 1.5 | color, normal, arm | ambientCG (Lennart Demes); roughness calibrated to 0.42 |
| `container_side` | [container_side](https://polyhaven.com/a/container_side) (Poly Haven) | 1K | 1.94 | color, normal, arm | Dimitrios Savva |
| `osb` | [oriented_strand_board](https://polyhaven.com/a/oriented_strand_board) (Poly Haven) | 1K | 2.51 | color, normal, arm | Dimitrios Savva |
| `facade_office_glass` | [Facade001](https://ambientcg.com/a/Facade001) (ambientCG) | 1K | 36 | color, normal, arm, emissive | ambientCG (Lennart Demes); emission from [Facade002](https://ambientcg.com/a/Facade002) |
| `facade_office_ribbon` | [Facade006](https://ambientcg.com/a/Facade006) (ambientCG) | 1K | 28 | color, normal, arm | ambientCG (Lennart Demes) |
| `facade_brick_windows` | [Facade018A](https://ambientcg.com/a/Facade018A) (ambientCG) | 1K | 20 | color, normal, arm, emissive | ambientCG (Lennart Demes); emission from [Facade018B](https://ambientcg.com/a/Facade018B) |
| `facade_concrete_windows` | [Facade019A](https://ambientcg.com/a/Facade019A) (ambientCG) | 1K | 20 | color, normal, arm, emissive | ambientCG (Lennart Demes); emission from [Facade019B](https://ambientcg.com/a/Facade019B) |
| `facade_residential_1` | [Facade020A](https://ambientcg.com/a/Facade020A) (ambientCG) | 1K | 20 | color, normal, arm, emissive | ambientCG (Lennart Demes); emission from [Facade020B](https://ambientcg.com/a/Facade020B) |
| `facade_residential_2` | [Facade012](https://ambientcg.com/a/Facade012) (ambientCG) | 1K | 112 | color, normal, arm, emissive | ambientCG (Lennart Demes) |
| `facade_far_office` | [Facade015](https://ambientcg.com/a/Facade015) (ambientCG) | 1K | 112 | color, normal, arm, emissive | ambientCG (Lennart Demes) |

## HDRIs (equirectangular .hdr, pure sky)

| Manifest name | Source asset | Res | Sun elevation | Authors |
|---|---|---|---|---|
| `hdri_day_cloudy` | [kloofendal_48d_partly_cloudy_puresky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) (Poly Haven) | 2K | 47.9° | Greg Zaal, Jarod Guest |
| `hdri_day_clear` | [kloofendal_43d_clear_puresky](https://polyhaven.com/a/kloofendal_43d_clear_puresky) (Poly Haven) | 2K | 42.9° | Greg Zaal |
| `hdri_overcast` | [kloofendal_overcast_puresky](https://polyhaven.com/a/kloofendal_overcast_puresky) (Poly Haven) | 2K | 22.7° | Greg Zaal |
| `hdri_sunset` | [kloppenheim_06_puresky](https://polyhaven.com/a/kloppenheim_06_puresky) (Poly Haven) | 2K | 5.9° | Greg Zaal, Jarod Guest |
| `hdri_dawn` | [qwantani_dawn_puresky](https://polyhaven.com/a/qwantani_dawn_puresky) (Poly Haven) | 1K | 8.3° | Greg Zaal, Jarod Guest |
| `hdri_night` | [kloppenheim_02_puresky](https://polyhaven.com/a/kloppenheim_02_puresky) (Poly Haven) | 1K | 17.1° | Greg Zaal, Jarod Guest |

## Models (glTF 2.0, 1K textures)

| Manifest name | Source asset | Size (Blender x·y·z, m) | Authors |
|---|---|---|---|
| `jersey_barrier` | [concrete_road_barrier_02](https://polyhaven.com/a/concrete_road_barrier_02) (Poly Haven) | 1.57 × 0.44 × 1.11 | Amal Kumar |
| `oil_drum` | [barrel_03](https://polyhaven.com/a/barrel_03) (Poly Haven) | 0.63 × 0.64 × 0.93 | Serhii Khromov |
| `plastic_drum` | [Barrel_02](https://polyhaven.com/a/Barrel_02) (Poly Haven) | 0.49 × 0.48 × 0.88 | Jorge Camacho |
| `wooden_crate` | [wooden_crate_02](https://polyhaven.com/a/wooden_crate_02) (Poly Haven) | 1.17 × 0.53 × 0.46 | James Ray Cock, Jurita Burger |
| `cement_bag` | [cement_bag](https://polyhaven.com/a/cement_bag) (Poly Haven) | 0.46 × 0.70 × 0.18 | PierreB3D |
| `generator` | [portable_generator](https://polyhaven.com/a/portable_generator) (Poly Haven) | 0.82 × 0.56 × 0.58 | James Ray Cock |
| `gas_cylinder` | [small_lpg_tank](https://polyhaven.com/a/small_lpg_tank) (Poly Haven) | 0.41 × 0.41 × 0.64 | Ulan Cabanilla |
| `utility_box` | [utility_box_02](https://polyhaven.com/a/utility_box_02) (Poly Haven) | 0.92 × 0.43 × 1.12 | James Ray Cock |
| `manhole_cover` | [water_manhole_cover](https://polyhaven.com/a/water_manhole_cover) (Poly Haven) | 0.69 × 0.69 × 0.07 | Raunox |
| `aircon_unit` | [exterior_aircon_unit](https://polyhaven.com/a/exterior_aircon_unit) (Poly Haven) | 1.80 × 0.37 × 0.93 | Monsta3D |
| `shrubs_large` | [shrub_02](https://polyhaven.com/a/shrub_02) (Poly Haven) | 5.34 × 2.06 × 2.07 | Rico Cilliers |
| `shrubs_small` | [shrub_03](https://polyhaven.com/a/shrub_03) (Poly Haven) | 1.37 × 0.15 × 0.40 | Rico Cilliers |
