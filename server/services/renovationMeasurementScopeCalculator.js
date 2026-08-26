export function calculateMaterialQuantities(roomDimensions, roomType, renovationType) {
  const { floorAreaSqFt, wallAreaSqFt, perimeterFt, widthFt, lengthFt } = roomDimensions;
  const items = [];
  const type = (renovationType || roomType || '').toLowerCase();
  const isVanityScope = type.includes('vanity');
  const isToiletScope = type.includes('toilet');
  const isMirrorScope = type.includes('mirror');
  const isFaucetScope = type.includes('faucet');
  const isCountertopScope = type.includes('countertop');
  const isCabinetScope = type.includes('cabinet');
  const isSinkScope = type.includes('sink');
  const isShowerScope = type.includes('shower');
  const isTubScope = type.includes('bathtub') || type.includes('tub');
  const isBathroomFixtureScope = isVanityScope || isToiletScope || isMirrorScope || isFaucetScope || isSinkScope || isShowerScope || isTubScope;
  const paintableWallArea = roomDimensions?.wallAreaIncludesOpenings === false
    ? Math.round(wallAreaSqFt)
    : Math.round(wallAreaSqFt * 0.85);

  if (['flooring', 'hardwood', 'lvp', 'tile', 'carpet', 'kitchen', 'bathroom', 'bedroom', 'living_room', 'dining_room', 'hallway', 'foyer', 'basement', 'office', 'utility', 'laundry'].some(t => type.includes(t))) {
    const isFloorTile = type.includes('tile') || type.includes('bathroom');
    const wasteFactor = isFloorTile ? 1.15 : 1.10;
    const flooringQty = Math.ceil(floorAreaSqFt * wasteFactor);

    if (isFloorTile) {
      items.push({ item: 'Porcelain floor tile', quantity: flooringQty, unit: 'sq_ft', category: 'flooring', dbKey: 'tile_porcelain', wastePercent: 15 });
      items.push({ item: 'Thinset mortar (floor)', quantity: Math.ceil(flooringQty / 50), unit: 'bag', category: 'tile', dbKey: 'tile_adhesive_thinset', fallbackCost: 18 });
      items.push({ item: 'Tile grout (sanded)', quantity: Math.ceil(flooringQty / 70), unit: 'bag', category: 'tile', dbKey: 'tile_grout', fallbackCost: 15 });
      items.push({ item: 'Tile spacers & leveling clips', quantity: Math.ceil(flooringQty / 25), unit: 'pack', category: 'tile', fallbackCost: 8 });
    } else if (type.includes('hardwood')) {
      items.push({ item: 'Engineered hardwood flooring', quantity: flooringQty, unit: 'sq_ft', category: 'flooring', dbKey: 'engineered_hardwood', wastePercent: 10 });
      items.push({ item: 'Underlayment', quantity: Math.ceil(floorAreaSqFt), unit: 'sq_ft', category: 'flooring', dbKey: 'underlayment', fallbackCost: 0.50 });
      items.push({ item: 'Floor transitions', quantity: Math.max(2, Math.ceil(perimeterFt / 15)), unit: 'each', category: 'flooring', dbKey: 'floor_transition', fallbackCost: 15 });
    } else {
      items.push({ item: 'LVP luxury vinyl plank', quantity: flooringQty, unit: 'sq_ft', category: 'flooring', dbKey: 'lvp_luxury_vinyl_plank', wastePercent: 10 });
      items.push({ item: 'Underlayment', quantity: Math.ceil(floorAreaSqFt), unit: 'sq_ft', category: 'flooring', dbKey: 'underlayment', fallbackCost: 0.50 });
      items.push({ item: 'Floor transitions', quantity: Math.max(2, Math.ceil(perimeterFt / 15)), unit: 'each', category: 'flooring', dbKey: 'floor_transition', fallbackCost: 15 });
    }
  }

  if (['paint', 'painting', 'cosmetic', 'refresh', 'kitchen', 'bathroom', 'bedroom', 'living_room', 'dining_room', 'hallway', 'foyer', 'basement', 'office', 'utility', 'laundry'].some(t => type.includes(t))) {
    const paintGallons = Math.ceil(paintableWallArea / 350);
    const primerGallons = Math.ceil(paintableWallArea / 300);
    items.push({ item: 'Interior paint (2 coats)', quantity: paintGallons * 2, unit: 'gallon', category: 'paint', dbKey: 'interior_paint_gallon', coverageSqFt: paintableWallArea });
    items.push({ item: 'Primer', quantity: primerGallons, unit: 'gallon', category: 'paint', dbKey: 'primer_gallon', fallbackCost: 30 });
    items.push({ item: 'Paint supplies (tape, rollers, drop cloths)', quantity: 1, unit: 'set', category: 'paint', dbKey: 'paint_supplies', fallbackCost: 45 });
  }

  if (['paint', 'painting', 'cosmetic', 'refresh', 'ceiling'].some(t => type.includes(t))) {
    items.push({ item: 'Ceiling paint (flat white)', quantity: Math.ceil(floorAreaSqFt / 350), unit: 'gallon', category: 'paint', dbKey: 'ceiling_paint_gallon', fallbackCost: 35, coverageSqFt: floorAreaSqFt });
  }

  if (type.includes('ceiling')) {
    const ceilingAreaSqFt = Math.max(20, Math.round(floorAreaSqFt));
    const tileCount = Math.ceil((ceilingAreaSqFt / 4) * 1.08);
    const gridMainTees = Math.max(4, Math.ceil(Math.max(widthFt || 0, lengthFt || 0) / 4));
    const gridCrossTees = Math.max(8, Math.ceil(ceilingAreaSqFt / 8));
    items.push({ item: 'Acoustic ceiling tiles (2x2)', quantity: tileCount, unit: 'each', category: 'ceiling', fallbackCost: 6 });
    items.push({ item: 'Suspended ceiling main tees', quantity: gridMainTees, unit: 'each', category: 'ceiling', fallbackCost: 9 });
    items.push({ item: 'Suspended ceiling cross tees', quantity: gridCrossTees, unit: 'each', category: 'ceiling', fallbackCost: 4 });
    items.push({ item: 'Wall angle / perimeter trim', quantity: Math.ceil(perimeterFt * 1.08), unit: 'linear_ft', category: 'ceiling', fallbackCost: 1.5 });
    items.push({ item: 'Hanger wire + anchors', quantity: Math.max(12, Math.ceil(ceilingAreaSqFt / 12)), unit: 'set', category: 'ceiling', fallbackCost: 2 });
    items.push({ item: 'Drywall patch / backing for light penetrations', quantity: Math.max(1, Math.ceil(ceilingAreaSqFt / 80)), unit: 'sheet', category: 'drywall', fallbackCost: 18 });
  }

  if (['flooring', 'baseboard', 'trim', 'refresh', 'kitchen', 'bedroom', 'living_room'].some(t => type.includes(t))) {
    const baseboardFt = Math.ceil(perimeterFt * 1.10);
    items.push({ item: 'Baseboard trim (MDF primed)', quantity: baseboardFt, unit: 'linear_ft', category: 'trim', fallbackCost: 1.50 });
    items.push({ item: 'Quarter round shoe molding', quantity: baseboardFt, unit: 'linear_ft', category: 'trim', fallbackCost: 0.75 });
    items.push({ item: 'Trim paint (semi-gloss)', quantity: Math.max(1, Math.ceil(baseboardFt / 200)), unit: 'gallon', category: 'paint', dbKey: 'interior_paint_gallon', fallbackCost: 40 });
    items.push({ item: 'Paintable caulk', quantity: Math.max(2, Math.ceil(perimeterFt / 50)), unit: 'tube', category: 'trim', fallbackCost: 5 });
    items.push({ item: 'Brad nails (18 gauge)', quantity: 1, unit: 'box', category: 'trim', fallbackCost: 12 });
    items.push({ item: 'Wood filler', quantity: 1, unit: 'tube', category: 'trim', fallbackCost: 8 });
  }

  if (type.includes('bathroom')) {
    const showerSurroundSqFt = 65;
    items.push({ item: 'Subway tile (shower surround)', quantity: Math.ceil(showerSurroundSqFt * 1.15), unit: 'sq_ft', category: 'tile', dbKey: 'subway_tile', wastePercent: 15 });
    items.push({ item: 'Thinset mortar (shower)', quantity: Math.ceil(showerSurroundSqFt / 50), unit: 'bag', category: 'tile', dbKey: 'tile_adhesive_thinset', fallbackCost: 18 });
    items.push({ item: 'Tile trim / bullnose', quantity: 20, unit: 'linear_ft', category: 'tile', dbKey: 'tile_trim_bullnose', fallbackCost: 4 });
    items.push({ item: 'Waterproofing membrane (RedGard)', quantity: 1, unit: 'gallon', category: 'tile', fallbackCost: 45 });
    items.push({ item: 'Cement board (backer)', quantity: Math.ceil(showerSurroundSqFt / 15), unit: 'sheet', category: 'tile', fallbackCost: 12 });
    items.push({ item: 'Grout (shower)', quantity: Math.ceil(showerSurroundSqFt / 70), unit: 'bag', category: 'tile', dbKey: 'tile_grout', fallbackCost: 15 });
    items.push({ item: 'Toilet (dual flush)', quantity: 1, unit: 'each', category: 'plumbing', dbKey: 'toilet_dual_flush' });
    items.push({ item: 'Bathroom faucet (single-hole)', quantity: 1, unit: 'each', category: 'plumbing', dbKey: 'bathroom_faucet' });
    items.push({ item: 'Shower head + valve trim kit', quantity: 1, unit: 'each', category: 'plumbing', fallbackCost: 150 });
    items.push({ item: 'Shower mixing valve (rough-in)', quantity: 1, unit: 'each', category: 'plumbing', fallbackCost: 80 });
    items.push({ item: 'Supply lines & drain kit', quantity: 1, unit: 'set', category: 'plumbing', fallbackCost: 35 });
    items.push({ item: 'Wax ring + toilet bolts', quantity: 1, unit: 'set', category: 'plumbing', fallbackCost: 8 });
    items.push({ item: 'Vanity light fixture', quantity: 1, unit: 'each', category: 'lighting', dbKey: 'vanity_light' });
    items.push({ item: 'Exhaust fan (quiet, 80+ CFM)', quantity: 1, unit: 'each', category: 'electrical', fallbackCost: 90 });
    items.push({ item: 'GFCI outlet', quantity: 1, unit: 'each', category: 'lighting', dbKey: 'outlet_gfci', fallbackCost: 20 });
    items.push({ item: 'Bathroom mirror (framed)', quantity: 1, unit: 'each', category: 'vanity', dbKey: 'bathroom_mirror', fallbackCost: 120 });
    items.push({ item: 'Towel bar + accessories kit', quantity: 1, unit: 'set', category: 'bathroom', fallbackCost: 60 });
    items.push({ item: 'Toilet paper holder', quantity: 1, unit: 'each', category: 'bathroom', fallbackCost: 20 });
    items.push({ item: 'Shower curtain rod + curtain', quantity: 1, unit: 'set', category: 'bathroom', fallbackCost: 45 });
  }

  if (isVanityScope) {
    const vanityWidthInches = roomType?.includes('bathroom') ? 36 : 30;
    const vanityTopSqFt = Math.max(6, Math.round((vanityWidthInches / 12) * 1.9));
    items.push({ item: 'Bathroom vanity cabinet with integrated top', quantity: 1, unit: 'each', category: 'vanity', fallbackCost: 650 });
    items.push({ item: 'Quartz vanity top', quantity: vanityTopSqFt, unit: 'sq_ft', category: 'countertops', dbKey: 'quartz', fallbackCost: 55 });
    items.push({ item: 'Bathroom faucet (single-hole)', quantity: 1, unit: 'each', category: 'plumbing', dbKey: 'bathroom_faucet' });
    items.push({ item: 'Pop-up drain + supply kit', quantity: 1, unit: 'set', category: 'plumbing', fallbackCost: 45 });
    items.push({ item: 'Bathroom mirror (framed)', quantity: 1, unit: 'each', category: 'vanity', dbKey: 'bathroom_mirror', fallbackCost: 120 });
    items.push({ item: 'Vanity light fixture', quantity: 1, unit: 'each', category: 'lighting', dbKey: 'vanity_light', fallbackCost: 160 });
    items.push({ item: 'Silicone + mounting adhesive', quantity: 1, unit: 'set', category: 'bathroom', fallbackCost: 24 });
  }

  if (isToiletScope) {
    items.push({ item: 'Toilet (dual flush)', quantity: 1, unit: 'each', category: 'plumbing', dbKey: 'toilet_dual_flush' });
    items.push({ item: 'Wax ring + toilet bolts', quantity: 1, unit: 'set', category: 'plumbing', fallbackCost: 8 });
    items.push({ item: 'Braided toilet supply line', quantity: 1, unit: 'each', category: 'plumbing', fallbackCost: 18 });
    items.push({ item: 'Closet flange repair ring', quantity: 1, unit: 'each', category: 'plumbing', fallbackCost: 20 });
  }

  if (isMirrorScope) {
    items.push({ item: 'Bathroom mirror (framed)', quantity: 1, unit: 'each', category: 'vanity', dbKey: 'bathroom_mirror', fallbackCost: 120 });
    items.push({ item: 'Mirror mounting hardware kit', quantity: 1, unit: 'set', category: 'bathroom', fallbackCost: 18 });
  }

  if (isFaucetScope && !isVanityScope) {
    const isKitchenFixture = type.includes('kitchen');
    items.push({
      item: isKitchenFixture ? 'Kitchen faucet (pull-down)' : 'Bathroom faucet (single-hole)',
      quantity: 1,
      unit: 'each',
      category: 'plumbing',
      dbKey: isKitchenFixture ? 'kitchen_faucet' : 'bathroom_faucet',
      fallbackCost: isKitchenFixture ? 220 : 150,
    });
    items.push({ item: 'Supply lines + install kit', quantity: 1, unit: 'set', category: 'plumbing', fallbackCost: 32 });
  }

  if (isSinkScope && !type.includes('kitchen')) {
    items.push({ item: 'Bathroom sink basin', quantity: 1, unit: 'each', category: 'vanity', fallbackCost: 140 });
    items.push({ item: 'Drain assembly + trap kit', quantity: 1, unit: 'set', category: 'plumbing', fallbackCost: 45 });
  }

  if (isCountertopScope && !type.includes('kitchen')) {
    const vanityTopSqFt = Math.max(6, Math.round(((widthFt || 3) * 2)));
    items.push({ item: 'Quartz vanity top', quantity: vanityTopSqFt, unit: 'sq_ft', category: 'countertops', dbKey: 'quartz', fallbackCost: 55 });
    items.push({ item: 'Backsplash side splash kit', quantity: 1, unit: 'set', category: 'countertops', fallbackCost: 45 });
    items.push({ item: 'Silicone + seam kit', quantity: 1, unit: 'set', category: 'countertops', fallbackCost: 20 });
  }

  if (isCabinetScope && !type.includes('kitchen')) {
    items.push({ item: 'Bathroom vanity cabinet box', quantity: 1, unit: 'each', category: 'vanity', fallbackCost: 420 });
    items.push({ item: 'Vanity hardware kit', quantity: 1, unit: 'set', category: 'vanity', fallbackCost: 35 });
  }

  if (isShowerScope) {
    items.push({ item: 'Shower trim kit', quantity: 1, unit: 'each', category: 'plumbing', fallbackCost: 220 });
    items.push({ item: 'Shower pan liner / waterproof membrane', quantity: 1, unit: 'set', category: 'tile', fallbackCost: 95 });
    items.push({ item: 'Subway tile (shower surround)', quantity: Math.ceil(65 * 1.15), unit: 'sq_ft', category: 'tile', dbKey: 'subway_tile', wastePercent: 15 });
  }

  if (isTubScope) {
    items.push({ item: 'Acrylic alcove tub', quantity: 1, unit: 'each', category: 'plumbing', fallbackCost: 480 });
    items.push({ item: 'Tub waste + overflow kit', quantity: 1, unit: 'set', category: 'plumbing', fallbackCost: 85 });
  }

  if (type.includes('kitchen') || type.includes('countertop') || type.includes('cabinet')) {
    const counterRunFt = Math.round(perimeterFt * 0.55);
    const counterSqFt = Math.round(counterRunFt * (25 / 12));
    const backsplashSqFt = Math.round(counterRunFt * 1.5);

    if (type.includes('countertop') || type.includes('kitchen')) {
      items.push({ item: 'Quartz countertop (fabricated & installed)', quantity: counterSqFt, unit: 'sq_ft', category: 'countertops', dbKey: 'quartz' });
      items.push({ item: 'Countertop edge profile (eased)', quantity: counterRunFt, unit: 'linear_ft', category: 'countertops', fallbackCost: 10 });
    }

    if (type.includes('cabinet') || type.includes('kitchen')) {
      items.push({ item: 'Lower/base cabinets (semi-custom)', quantity: counterRunFt, unit: 'linear_ft', category: 'cabinets', dbKey: 'semi_custom_base' });
      items.push({ item: 'Upper/wall cabinets (semi-custom)', quantity: Math.round(counterRunFt * 0.7), unit: 'linear_ft', category: 'cabinets', dbKey: 'semi_custom_upper' });
      items.push({ item: 'Cabinet hardware (pulls/knobs)', quantity: Math.round(counterRunFt * 2), unit: 'each', category: 'cabinets', dbKey: 'cabinet_hardware', fallbackCost: 5 });
      items.push({ item: 'Soft-close hinges', quantity: Math.round(counterRunFt * 3), unit: 'each', category: 'cabinets', dbKey: 'soft_close_hinges', fallbackCost: 3 });
      items.push({ item: 'Cabinet interior shelving', quantity: Math.round(counterRunFt * 0.8), unit: 'each', category: 'cabinets', fallbackCost: 15 });
    }

    if (type.includes('kitchen')) {
      items.push({ item: 'Subway tile backsplash', quantity: Math.ceil(backsplashSqFt * 1.15), unit: 'sq_ft', category: 'tile', dbKey: 'subway_tile', wastePercent: 15 });
      items.push({ item: 'Thinset mortar (backsplash)', quantity: Math.ceil(backsplashSqFt / 50), unit: 'bag', category: 'tile', dbKey: 'tile_adhesive_thinset', fallbackCost: 18 });
      items.push({ item: 'Backsplash grout', quantity: Math.ceil(backsplashSqFt / 70), unit: 'bag', category: 'tile', dbKey: 'tile_grout', fallbackCost: 15 });
      items.push({ item: 'Kitchen sink (stainless undermount)', quantity: 1, unit: 'each', category: 'plumbing', dbKey: 'kitchen_sink_stainless' });
      items.push({ item: 'Kitchen faucet (pull-down)', quantity: 1, unit: 'each', category: 'plumbing', dbKey: 'kitchen_faucet' });
      items.push({ item: 'Garbage disposal (1/2 HP)', quantity: 1, unit: 'each', category: 'appliances', dbKey: 'garbage_disposal', fallbackCost: 120 });
      items.push({ item: 'Refrigerator (French door, 25 cu ft)', quantity: 1, unit: 'each', category: 'appliances', fallbackCost: 1200 });
      items.push({ item: 'Gas/electric range (30" freestanding)', quantity: 1, unit: 'each', category: 'appliances', fallbackCost: 750 });
      items.push({ item: 'Dishwasher (built-in, stainless)', quantity: 1, unit: 'each', category: 'appliances', fallbackCost: 550 });
      items.push({ item: 'Over-range microwave (1.7 cu ft)', quantity: 1, unit: 'each', category: 'appliances', fallbackCost: 300 });
      items.push({ item: 'Under-cabinet LED lighting', quantity: counterRunFt, unit: 'linear_ft', category: 'lighting', dbKey: 'under_cabinet_light', fallbackCost: 8 });
      items.push({ item: 'GFCI outlets (kitchen)', quantity: 3, unit: 'each', category: 'lighting', dbKey: 'outlet_gfci', fallbackCost: 20 });
      items.push({ item: 'Dishwasher supply line + drain', quantity: 1, unit: 'set', category: 'plumbing', fallbackCost: 25 });
    }
  }

  if (type.includes('lighting') || type.includes('ceiling') || type.includes('electrical')) {
    const recessedCount = Math.max(4, Math.round(floorAreaSqFt / 25));
    items.push({ item: 'Recessed LED can lights (6")', quantity: recessedCount, unit: 'each', category: 'lighting', dbKey: 'recessed_light', fallbackCost: 25 });
    items.push({ item: 'LED light bulbs (dimmable)', quantity: recessedCount, unit: 'each', category: 'lighting', fallbackCost: 8 });
    items.push({ item: 'Dimmer switch', quantity: 1, unit: 'each', category: 'lighting', dbKey: 'dimmer_switch', fallbackCost: 25 });
    if (floorAreaSqFt > 100) {
      items.push({ item: 'Ceiling fan with light kit', quantity: 1, unit: 'each', category: 'lighting', dbKey: 'ceiling_fan', fallbackCost: 200 });
    }
  }

  if (type.includes('window')) {
    const windowCount = Math.max(1, Math.round(perimeterFt / 10));
    items.push({ item: 'Double-hung vinyl window', quantity: windowCount, unit: 'each', category: 'windows', dbKey: 'window_vinyl_double_hung', fallbackCost: 450 });
    items.push({ item: 'Window trim (casing)', quantity: windowCount * 17, unit: 'linear_ft', category: 'trim', fallbackCost: 2 });
    items.push({ item: 'Window sill', quantity: windowCount, unit: 'each', category: 'trim', fallbackCost: 15 });
  }

  if (type.includes('drywall') || type.includes('wall') || type.includes('demo')) {
    const sheetCount = Math.ceil(wallAreaSqFt / 32);
    items.push({ item: 'Drywall sheets (4x8, 1/2")', quantity: sheetCount, unit: 'sheet', category: 'drywall', fallbackCost: 14 });
    items.push({ item: 'Joint compound (all-purpose)', quantity: Math.ceil(sheetCount / 4), unit: 'bucket', category: 'drywall', fallbackCost: 18 });
    items.push({ item: 'Drywall tape', quantity: Math.ceil(perimeterFt / 50), unit: 'roll', category: 'drywall', fallbackCost: 6 });
    items.push({ item: 'Drywall screws', quantity: Math.ceil(sheetCount / 3), unit: 'box', category: 'drywall', fallbackCost: 10 });
  }

  return items;
}

export function calculateLaborItems(roomDimensions, roomType, renovationType) {
  const { floorAreaSqFt, wallAreaSqFt, perimeterFt } = roomDimensions;
  const items = [];
  const type = (renovationType || roomType || '').toLowerCase();
  const isVanityScope = type.includes('vanity');
  const isToiletScope = type.includes('toilet');
  const isMirrorScope = type.includes('mirror');
  const isFaucetScope = type.includes('faucet');
  const isCountertopScope = type.includes('countertop');
  const isCabinetScope = type.includes('cabinet');
  const isSinkScope = type.includes('sink');
  const isShowerScope = type.includes('shower');
  const isTubScope = type.includes('bathtub') || type.includes('tub');
  const isBathroomFixtureScope = isVanityScope || isToiletScope || isMirrorScope || isFaucetScope || isSinkScope || isShowerScope || isTubScope;

  items.push({ task: 'Demolition & debris removal', tradeType: 'general_labor', estimatedHours: isBathroomFixtureScope ? 2 : Math.max(2, Math.round(floorAreaSqFt / 50)), rateKey: 'general_labor' });
  items.push({ task: 'Surface preparation & cleanup', tradeType: 'general_labor', estimatedHours: isBathroomFixtureScope ? 1 : Math.max(2, Math.round(floorAreaSqFt / 80)), rateKey: 'general_labor' });

  if (['flooring', 'hardwood', 'lvp', 'tile', 'carpet', 'kitchen', 'bathroom', 'bedroom', 'living_room', 'hallway', 'foyer', 'basement', 'office', 'utility', 'laundry'].some(t => type.includes(t))) {
    const isFloorTile = type.includes('tile') || type.includes('bathroom');
    items.push({
      task: isFloorTile ? 'Floor tile installation' : 'Flooring installation (LVP/hardwood)',
      tradeType: isFloorTile ? 'tile_setter' : 'flooring_installer',
      estimatedHours: Math.max(4, Math.round(floorAreaSqFt / (isFloorTile ? 15 : 25))),
      rateKey: isFloorTile ? 'tile_setter' : 'flooring_installer',
    });
  }

  if (['paint', 'painting', 'cosmetic', 'refresh', 'kitchen', 'bathroom', 'bedroom', 'living_room', 'hallway', 'foyer', 'basement', 'office', 'utility', 'laundry'].some(t => type.includes(t))) {
    items.push({ task: 'Wall painting (2 coats + primer)', tradeType: 'painter', estimatedHours: Math.max(3, Math.round(wallAreaSqFt / 100)), rateKey: 'painter' });
  }

  if (type.includes('ceiling')) {
    items.push({ task: 'Suspended ceiling grid layout + installation', tradeType: 'carpenter', estimatedHours: Math.max(4, Math.round(floorAreaSqFt / 35)), rateKey: 'carpenter' });
    items.push({ task: 'Acoustic ceiling tile install + trimming', tradeType: 'general_labor', estimatedHours: Math.max(3, Math.round(floorAreaSqFt / 45)), rateKey: 'general_labor' });
    items.push({ task: 'Ceiling patching / paint touch-up', tradeType: 'painter', estimatedHours: Math.max(2, Math.round(floorAreaSqFt / 120)), rateKey: 'painter' });
  }

  if (['baseboard', 'trim', 'flooring'].some(t => type.includes(t))) {
    items.push({ task: 'Baseboard / trim installation', tradeType: 'carpenter', estimatedHours: Math.max(2, Math.round(perimeterFt / 20)), rateKey: 'carpenter' });
  }

  if (type.includes('bathroom')) {
    items.push({ task: 'Toilet removal + installation', tradeType: 'plumber', estimatedHours: 2, rateKey: 'plumber' });
    items.push({ task: 'Vanity + faucet installation', tradeType: 'plumber', estimatedHours: 3, rateKey: 'plumber' });
    items.push({ task: 'Shower tile installation (prep + waterproof + tile + grout)', tradeType: 'tile_setter', estimatedHours: 12, rateKey: 'tile_setter' });
    items.push({ task: 'Exhaust fan + GFCI wiring', tradeType: 'electrician', estimatedHours: 2, rateKey: 'electrician' });
    items.push({ task: 'Plumbing rough-in (shower valve)', tradeType: 'plumber', estimatedHours: 3, rateKey: 'plumber' });
    items.push({ task: 'Accessories installation (mirror, towel bars)', tradeType: 'general_labor', estimatedHours: 1, rateKey: 'general_labor' });
  }

  if (isVanityScope) {
    items.push({ task: 'Vanity cabinet set + level', tradeType: 'carpenter', estimatedHours: 2.5, rateKey: 'carpenter' });
    items.push({ task: 'Vanity top + faucet hookup', tradeType: 'plumber', estimatedHours: 3.5, rateKey: 'plumber' });
    items.push({ task: 'Mirror + vanity light installation', tradeType: 'electrician', estimatedHours: 1.5, rateKey: 'electrician' });
  }

  if (isToiletScope) {
    items.push({ task: 'Toilet replacement + wax ring reset', tradeType: 'plumber', estimatedHours: 2, rateKey: 'plumber' });
  }

  if (isMirrorScope) {
    items.push({ task: 'Mirror layout + installation', tradeType: 'general_labor', estimatedHours: 1, rateKey: 'general_labor' });
  }

  if (isFaucetScope && !isVanityScope) {
    items.push({ task: 'Fixture faucet replacement', tradeType: 'plumber', estimatedHours: 1.5, rateKey: 'plumber' });
  }

  if (isSinkScope && !type.includes('kitchen')) {
    items.push({ task: 'Sink basin swap + drain hookup', tradeType: 'plumber', estimatedHours: 2, rateKey: 'plumber' });
  }

  if (isCountertopScope && !type.includes('kitchen')) {
    items.push({ task: 'Vanity top template + install', tradeType: 'countertop_installer', estimatedHours: 3, rateKey: 'countertop_installer' });
    items.push({ task: 'Sink/faucet reconnect', tradeType: 'plumber', estimatedHours: 1.5, rateKey: 'plumber' });
  }

  if (isCabinetScope && !type.includes('kitchen')) {
    items.push({ task: 'Vanity cabinet installation', tradeType: 'cabinet_installer', estimatedHours: 2.5, rateKey: 'carpenter' });
  }

  if (isShowerScope) {
    items.push({ task: 'Shower waterproofing + trim installation', tradeType: 'tile_setter', estimatedHours: 8, rateKey: 'tile_setter' });
    items.push({ task: 'Shower valve / trim hookup', tradeType: 'plumber', estimatedHours: 2.5, rateKey: 'plumber' });
  }

  if (isTubScope) {
    items.push({ task: 'Tub set + drain assembly', tradeType: 'plumber', estimatedHours: 4, rateKey: 'plumber' });
  }

  if (type.includes('kitchen')) {
    items.push({ task: 'Cabinet installation (uppers + lowers)', tradeType: 'cabinet_installer', estimatedHours: Math.max(6, Math.round(perimeterFt * 0.55 / 3)), rateKey: 'carpenter' });
    items.push({ task: 'Countertop template + installation', tradeType: 'countertop_installer', estimatedHours: 4, rateKey: 'countertop_installer' });
    items.push({ task: 'Backsplash tile installation', tradeType: 'tile_setter', estimatedHours: 6, rateKey: 'tile_setter' });
    items.push({ task: 'Sink + faucet + disposal hookup', tradeType: 'plumber', estimatedHours: 3, rateKey: 'plumber' });
    items.push({ task: 'Appliance delivery + installation (fridge, range, dishwasher, microwave)', tradeType: 'general_labor', estimatedHours: 4, rateKey: 'general_labor' });
    items.push({ task: 'Dishwasher + disposal hookup (water + drain + electrical)', tradeType: 'plumber', estimatedHours: 2, rateKey: 'plumber' });
    items.push({ task: 'Under-cabinet lighting + outlet wiring', tradeType: 'electrician', estimatedHours: 3, rateKey: 'electrician' });
    items.push({ task: 'Range gas/electric hookup', tradeType: 'plumber', estimatedHours: 1.5, rateKey: 'plumber' });
  }

  if (type.includes('countertop') && !type.includes('kitchen')) {
    items.push({ task: 'Countertop removal + installation', tradeType: 'countertop_installer', estimatedHours: 4, rateKey: 'countertop_installer' });
  }

  if (type.includes('cabinet') && !type.includes('kitchen')) {
    items.push({ task: 'Cabinet installation', tradeType: 'cabinet_installer', estimatedHours: Math.max(4, Math.round(perimeterFt * 0.5 / 3)), rateKey: 'carpenter' });
  }

  if (type.includes('lighting') || type.includes('ceiling') || type.includes('electrical')) {
    const lightCount = Math.max(4, Math.round(floorAreaSqFt / 25));
    items.push({ task: `Recessed light installation (${lightCount} lights)`, tradeType: 'electrician', estimatedHours: Math.max(3, lightCount), rateKey: 'electrician' });
    if (floorAreaSqFt > 100) {
      items.push({ task: 'Ceiling fan installation', tradeType: 'electrician', estimatedHours: 2, rateKey: 'electrician' });
    }
  }

  if (type.includes('window')) {
    const windowCount = Math.max(1, Math.round(perimeterFt / 10));
    items.push({ task: `Window installation (${windowCount} windows)`, tradeType: 'carpenter', estimatedHours: windowCount * 3, rateKey: 'carpenter' });
  }

  return items;
}