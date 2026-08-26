/**
 * CITY_PREFIX_MAP: CBSA code → FRED city prefix for BLS/BEA metro-level series.
 *
 * FRED uses a "city prefix" naming convention for many MSA-level series:
 *   {PREFIX}URN   = Unemployment Rate (Not Seasonally Adjusted, Monthly)
 *   {PREFIX}UR    = Unemployment Rate (Seasonally Adjusted, Monthly)
 *   {PREFIX}PCPI  = Per Capita Personal Income (Annual, DISCONTINUED but data available)
 *   {PREFIX}BPPRIVSA = Building Permits, Private Housing (Monthly SA)
 *
 * The prefix is NOT derivable from the CBSA code — it's a city abbreviation +
 * state FIPS code (e.g. AUST448 = Austin, TX where 48 = Texas FIPS).
 *
 * Built by scraping all URN, BPPRIVSA, and PCPI MSA series from FRED and
 * matching their titles to CBSA_CATALOG entries.
 *
 * Coverage: 377 CBSAs mapped (367 auto-matched + 10 manually added major metros)
 */

const CITY_PREFIX_MAP = {
  '10180': 'ABIL148',  // Abilene, TX
  '10420': 'AKRO439',  // Akron, OH
  '10500': 'ALBA513',  // Albany, GA
  '10540': 'ALBA941',  // Albany-Lebanon, OR
  '10580': 'ALBA536',  // Albany-Schenectady-Troy, NY
  '10740': 'ALBU735',  // Albuquerque, NM
  '10780': 'ALEX722',  // Alexandria, LA
  '10900': 'ALLE942',  // Allentown-Bethlehem-Easton, PA-NJ
  '11020': 'ALTO042',  // Altoona, PA
  '11100': 'AMAR148',  // Amarillo, TX
  '11180': 'AMES119',  // Ames, IA
  '11260': 'ANCH202',  // Anchorage, AK
  '11460': 'ANNA426',  // Ann Arbor, MI
  '11500': 'ANNI501',  // Anniston-Oxford, AL
  '11540': 'APPL555',  // Appleton, WI
  '11700': 'ASHE737',  // Asheville, NC
  '12020': 'ATHE013',  // Athens-Clarke County, GA
  '12060': 'ATLA013',  // Atlanta-Sandy Springs-Alpharetta, GA
  '12100': 'ATLA134',  // Atlantic City-Hammonton, NJ
  '12220': 'AUBU201',  // Auburn-Opelika, AL
  '12260': 'AUGU213',  // Augusta-Richmond County, GA-SC
  '12420': 'AUST448',  // Austin-Round Rock-Georgetown, TX
  '12540': 'BAKE506',  // Bakersfield-Delano, CA
  '12580': 'BALT524',  // Baltimore-Columbia-Towson, MD
  '12620': 'BANG723',  // Bangor, ME
  '12700': 'BARN925',  // Barnstable Town, MA
  '12940': 'BATO922',  // Baton Rouge, LA
  '12980': 'BATT926',  // Battle Creek, MI
  '13020': 'BAYC026',  // Bay City, MI
  '13140': 'BEAU148',  // Beaumont-Port Arthur, TX
  '13220': 'BECK954',  // Beckley, WV
  '13380': 'BELL353',  // Bellingham, WA
  '13460': 'BEND441',  // Bend, OR
  '13740': 'BILL730',  // Billings, MT
  '13780': 'BING736',  // Binghamton, NY
  '13820': 'BIRM801',  // Birmingham-Hoover, AL
  '13900': 'BISM938',  // Bismarck, ND
  '13980': 'BLAC951',  // Blacksburg-Christiansburg, VA
  '14010': 'BLOO017',  // Bloomington, IL
  '14020': 'BLOO018',  // Bloomington, IN
  '14100': 'BLOO942',  // Bloomsburg-Berwick, PA
  '14260': 'BOIS216',  // Boise City, ID
  '14500': 'BOUL508',  // Boulder, CO
  '14540': 'BOW',      // Bowling Green, KY
  '14740': 'BREM753',  // Bremerton-Silverdale-Port Orchard, WA
  '14860': 'BRID909',  // Bridgeport-Stamford-Norwalk, CT
  '15180': 'BROW148',  // Brownsville-Harlingen, TX
  '15260': 'BRUN213',  // Brunswick, GA
  '15380': 'BUFF336',  // Buffalo-Cheektowaga, NY
  '15500': 'BURL537',  // Burlington, NC
  '15540': 'BURL450',  // Burlington-South Burlington, VT
  '15680': 'CALX924',  // California-Lexington Park, MD
  '15940': 'CANT939',  // Canton-Massillon, OH
  '15980': 'CAPE912',  // Cape Coral-Fort Myers, FL
  '16060': 'CDMR917',  // Carbondale-Marion, IL
  '16180': 'CARS132',  // Carson City, NV
  '16220': 'CASP256',  // Casper, WY
  '16300': 'CEDA319',  // Cedar Rapids, IA
  '16540': 'CHWN942',  // Chambersburg-Waynesboro, PA
  '16580': 'CHAM517',  // Champaign-Urbana, IL
  '16620': 'CHAR654',  // Charleston, WV
  '16700': 'CHAR745',  // Charleston-North Charleston, SC
  '16740': 'CHAR737',  // Charlotte-Concord-Gastonia, NC-SC
  '16820': 'CHAR851',  // Charlottesville, VA
  '16860': 'CHAT847',  // Chattanooga, TN-GA
  '16940': 'CHEY956',  // Cheyenne, WY
  '16980': 'CHIC917',  // Chicago-Naperville-Elgin, IL-IN-WI  ← manually added
  '17020': 'CHIC006',  // Chico, CA
  '17140': 'CINC139',  // Cincinnati, OH-KY-IN
  '17300': 'CLH',      // Clarksville, TN-KY
  '17420': 'CLEV447',  // Cleveland, TN
  '17460': 'CLEV439',  // Cleveland-Elyria, OH
  '17660': 'COEU616',  // Coeur d'Alene, ID
  '17780': 'COLL748',  // College Station-Bryan, TX
  '17820': 'COLO808',  // Colorado Springs, CO
  '17860': 'CLM',      // Columbia, MO
  '17900': 'COLU945',  // Columbia, SC
  '17980': 'COLU913',  // Columbus, GA-AL
  '18020': 'COLU018',  // Columbus, IN
  '18140': 'COLU139',  // Columbus, OH
  '18580': 'CORP548',  // Corpus Christi, TX
  '18700': 'CORV741',  // Corvallis, OR
  '18880': 'FORT012',  // Crestview-Fort Walton Beach-Destin, FL
  '19060': 'CUMB024',  // Cumberland, MD-WV
  '19100': 'DALL148',  // Dallas-Fort Worth-Arlington, TX  ← manually added
  '19140': 'DALT113',  // Dalton, GA
  '19180': 'DANV117',  // Danville, IL
  '19300': 'DFHF901',  // Daphne-Fairhope-Foley, AL
  '19340': 'DAVE317',  // Davenport-Moline-Rock Island, IA-IL
  '19430': 'DAYT339',  // Dayton-Kettering, OH
  '19460': 'DECA401',  // Decatur, AL
  '19500': 'DECA517',  // Decatur, IL
  '19660': 'DELT612',  // Deltona-Daytona Beach-Ormond Beach, FL
  '19740': 'DENV708',  // Denver-Aurora-Lakewood, CO
  '19780': 'DESM719',  // Des Moines-West Des Moines, IA
  '19820': 'DETR826',  // Detroit-Warren-Dearborn, MI  ← manually added
  '20020': 'DOTH001',  // Dothan, AL
  '20100': 'DOVE110',  // Dover, DE
  '20220': 'DUBU219',  // Dubuque, IA
  '20260': 'DULU227',  // Duluth, MN-WI
  '20500': 'DURH537',  // Durham-Chapel Hill, NC
  '20700': 'ESTR942',  // East Stroudsburg, PA
  '20740': 'EAUC755',  // Eau Claire, WI
  '20940': 'ELCE906',  // El Centro, CA
  '21060': 'ELZ',      // Elizabethtown-Fort Knox, KY
  '21140': 'ELKH118',  // Elkhart-Goshen, IN
  '21300': 'ELMI336',  // Elmira, NY
  '21340': 'ELPA348',  // El Paso, TX
  '21500': 'ERIE542',  // Erie, PA
  '21660': 'EUGE641',  // Eugene-Springfield, OR
  '21780': 'EVN',      // Evansville, IN-KY
  '21820': 'FAIR802',  // Fairbanks, AK
  '22020': 'FARG038',  // Fargo, ND-MN
  '22140': 'FARM135',  // Farmington, NM
  '22180': 'FAYE137',  // Fayetteville, NC
  '22220': 'FAS',      // Fayetteville-Springdale-Rogers, AR
  '22380': 'FLAG304',  // Flagstaff, AZ
  '22420': 'FLIN426',  // Flint, MI
  '22500': 'FLOR545',  // Florence, SC
  '22520': 'FLOR501',  // Florence-Muscle Shoals, AL
  '22540': 'FOND555',  // Fond du Lac, WI
  '22660': 'FORT608',  // Fort Collins, CO
  '22900': 'FTS',      // Fort Smith, AR-OK
  '23060': 'FORT018',  // Fort Wayne, IN
  '23420': 'FRES406',  // Fresno, CA
  '23460': 'GADS401',  // Gadsden, AL
  '23540': 'GAIN512',  // Gainesville, FL
  '23580': 'GAIN513',  // Gainesville, GA
  '23900': 'GETT942',  // Gettysburg, PA
  '24020': 'GLEN036',  // Glens Falls, NY
  '24140': 'GOLD137',  // Goldsboro, NC
  '24220': 'GRAN238',  // Grand Forks, ND-MN
  '24260': 'GISL931',  // Grand Island, NE
  '24300': 'GRAN308',  // Grand Junction, CO
  '24340': 'GRAN326',  // Grand Rapids-Kentwood, MI
  '24420': 'GRPS941',  // Grants Pass, OR
  '24500': 'GREA530',  // Great Falls, MT
  '24540': 'GREE508',  // Greeley, CO
  '24580': 'GREE555',  // Green Bay, WI
  '24660': 'GREE637',  // Greensboro-High Point, NC
  '24780': 'GREE737',  // Greenville, NC
  '24860': 'GREE845',  // Greenville-Anderson, SC
  '25060': 'GULF028',  // Gulfport-Biloxi, MS
  '25180': 'HAGE124',  // Hagerstown-Martinsburg, MD-WV
  '25220': 'HAMM922',  // Hammond, LA
  '25260': 'HANF206',  // Hanford-Corcoran, CA
  '25420': 'HARR442',  // Harrisburg-Carlisle, PA
  '25500': 'HARR551',  // Harrisonburg, VA
  '25540': 'HART409',  // Hartford-East Hartford-Middletown, CT
  '25620': 'HATT628',  // Hattiesburg, MS
  '25860': 'HICK837',  // Hickory-Lenoir-Morganton, NC
  '25940': 'HHBB945',  // Hilton Head Island-Bluffton, SC
  '25980': 'HINE913',  // Hinesville, GA
  '26140': 'HMSP912',  // Homosassa Springs, FL
  '26300': 'HSP',      // Hot Springs, AR
  '26380': 'HOUM322',  // Houma-Thibodaux, LA
  '26420': 'HOUS448',  // Houston-The Woodlands-Sugar Land, TX
  '26580': 'HUNT554',  // Huntington-Ashland, WV-KY-OH
  '26620': 'HUNT601',  // Huntsville, AL
  '26820': 'IDAH816',  // Idaho Falls, ID
  '26900': 'INDI918',  // Indianapolis-Carmel-Anderson, IN
  '26980': 'IOWA919',  // Iowa City, IA
  '27060': 'ITHA036',  // Ithaca, NY
  '27100': 'JACK126',  // Jackson, MI
  '27140': 'JACK128',  // Jackson, MS
  '27180': 'JAC',      // Jackson, TN
  '27260': 'JACK212',  // Jacksonville, FL
  '27340': 'JACK337',  // Jacksonville, NC
  '27500': 'JANE555',  // Janesville-Beloit, WI
  '27620': 'JEF',      // Jefferson City, MO
  '27740': 'JOHN747',  // Johnson City, TN
  '27780': 'JOHN742',  // Johnstown, PA
  '27860': 'JOR',      // Jonesboro, AR
  '27900': 'JOPL929',  // Joplin, MO
  '27980': 'KAWALA915', // Kahului-Wailuku-Lahaina, HI
  '28020': 'KALA026',  // Kalamazoo-Portage, MI
  '28100': 'KANK117',  // Kankakee, IL
  '28140': 'KANS129',  // Kansas City, MO-KS
  '28420': 'KENN453',  // Kennewick-Richland, WA
  '28660': 'KILL648',  // Killeen-Temple, TX
  '28700': 'KING747',  // Kingsport-Bristol, TN-VA
  '28740': 'KING736',  // Kingston, NY
  '28940': 'KNOX947',  // Knoxville, TN
  '29020': 'KOKO018',  // Kokomo, IN
  '29100': 'LACR155',  // La Crosse-Onalaska, WI-MN
  '29180': 'LAFA122',  // Lafayette, LA
  '29200': 'LAFA118',  // Lafayette-West Lafayette, IN
  '29340': 'LAKE322',  // Lake Charles, LA
  '29420': 'LAKEHC',   // Lake Havasu City-Kingman, AZ
  '29460': 'LAKE412',  // Lakeland-Winter Haven, FL
  '29540': 'LANC542',  // Lancaster, PA
  '29620': 'LANS626',  // Lansing-East Lansing, MI
  '29700': 'LARE748',  // Laredo, TX
  '29740': 'LASC735',  // Las Cruces, NM
  '29820': 'LASV832',  // Las Vegas-Henderson-Paradise, NV
  '29940': 'LAWR920',  // Lawrence, KS
  '30020': 'LAWT040',  // Lawton, OK
  '30140': 'LEBA142',  // Lebanon, PA
  '30300': 'LEWI316',  // Lewiston, ID-WA
  '30340': 'LEWI623',  // Lewiston-Auburn, ME
  '30460': 'LEXI421',  // Lexington-Fayette, KY
  '30620': 'LIMA639',  // Lima, OH
  '30700': 'LINC731',  // Lincoln, NE
  '30780': 'LRS',      // Little Rock-North Little Rock-Conway, AR
  '30860': 'LOGA849',  // Logan, UT-ID
  '30980': 'LONG948',  // Longview, TX
  '31020': 'LONG053',  // Longview, WA
  '31080': 'LOSA106',  // Los Angeles-Long Beach-Anaheim, CA  ← manually corrected
  '31140': 'LOI',      // Louisville/Jefferson County, KY-IN
  '31180': 'LUBB148',  // Lubbock, TX
  '31340': 'LYNC351',  // Lynchburg, VA
  '31420': 'MACO413',  // Macon-Bibb County, GA
  '31460': 'MADE406',  // Madera-Chowchilla, CA
  '31540': 'MADI555',  // Madison, WI
  '31700': 'MANC933',  // Manchester-Nashua, NH
  '31900': 'MANS939',  // Mansfield, OH
  '32580': 'MCAL548',  // McAllen-Edinburg-Mission, TX
  '32780': 'MEDF741',  // Medford, OR
  '32820': 'MPH',      // Memphis, TN-MS-AR
  '32900': 'MERC906',  // Merced, CA
  '33100': 'MIAM112',  // Miami-Fort Lauderdale-West Palm Beach, FL  ← manually added
  '33140': 'MICH118',  // Michigan City-La Porte, IN
  '33220': 'MIDL926',  // Midland, MI
  '33260': 'MIDL248',  // Midland, TX
  '33340': 'MILW355',  // Milwaukee-Waukesha, WI
  '33460': 'MINN427',  // Minneapolis-St. Paul-Bloomington, MN-WI
  '33540': 'MISS530',  // Missoula, MT
  '33660': 'MOBI601',  // Mobile, AL
  '33700': 'MODE706',  // Modesto, CA
  '33740': 'MONR722',  // Monroe, LA
  '33780': 'MONR726',  // Monroe, MI
  '33860': 'MONT801',  // Montgomery, AL
  '34060': 'MORG054',  // Morgantown, WV
  '34100': 'MORR147',  // Morristown, TN
  '34580': 'MOUN553',  // Mount Vernon-Anacortes, WA
  '34620': 'MUNC618',  // Muncie, IN
  '34740': 'MUSK726',  // Muskegon, MI
  '34820': 'MYRT845',  // Myrtle Beach-Conway-North Myrtle Beach, SC-NC
  '34900': 'NAPA906',  // Napa, CA
  '34940': 'NAPL912',  // Naples-Marco Island, FL
  '34980': 'NASH947',  // Nashville-Davidson--Murfreesboro--Franklin, TN
  '35100': 'NEWB937',  // New Bern, NC
  '35300': 'NEWH709',  // New Haven-Milford, CT
  '35380': 'NEWO322',  // New Orleans-Metairie, LA
  '35620': 'NEWY636',  // New York-Newark-Jersey City, NY-NJ-PA  ← manually added
  '35660': 'NILE626',  // Niles, MI
  '35840': 'SARA212',  // North Port-Sarasota-Bradenton, FL
  '35980': 'NORW409',  // Norwich-New London, CT
  '36100': 'OCAL112',  // Ocala, FL
  '36140': 'OCEA134',  // Ocean City, NJ
  '36220': 'ODES248',  // Odessa, TX
  '36260': 'OGDE249',  // Ogden-Clearfield, UT
  '36420': 'OKLA440',  // Oklahoma City, OK
  '36500': 'OLYM553',  // Olympia-Lacey-Tumwater, WA
  '36540': 'OMAH531',  // Omaha-Council Bluffs, NE-IA
  '36740': 'ORLA712',  // Orlando-Kissimmee-Sanford, FL
  '36780': 'OSHK755',  // Oshkosh-Neenah, WI
  '36980': 'OWN',      // Owensboro, KY
  '37100': 'OXNA106',  // Oxnard-Thousand Oaks-Ventura, CA
  '37340': 'PALM312',  // Palm Bay-Melbourne-Titusville, FL
  '37460': 'PANA412',  // Panama City, FL
  '37620': 'PARK654',  // Parkersburg-Vienna, WV
  '37860': 'PENS812',  // Pensacola-Ferry Pass-Brent, FL
  '37900': 'PEOR917',  // Peoria, IL
  '37980': 'PHIL942',  // Philadelphia-Camden-Wilmington, PA-NJ-DE-MD  ← manually added
  '38060': 'PHOE004',  // Phoenix-Mesa-Chandler, AZ
  '38220': 'PBF',      // Pine Bluff, AR
  '38300': 'PITT342',  // Pittsburgh, PA
  '38340': 'PITT625',  // Pittsfield, MA
  '38540': 'POCA516',  // Pocatello, ID
  '38860': 'PORT723',  // Portland-South Portland, ME
  '38900': 'PORT941',  // Portland-Vancouver-Hillsboro, OR-WA
  '38940': 'PORT912',  // Port St. Lucie, FL
  '39100': 'POUG136',  // Poughkeepsie-Newburgh-Middletown, NY
  '39300': 'PROV244',  // Providence-Warwick, RI-MA
  '39340': 'PROV349',  // Provo-Orem, UT
  '39380': 'PUEB308',  // Pueblo, CO
  '39460': 'PUNT412',  // Punta Gorda, FL
  '39540': 'RACI555',  // Racine, WI
  '39580': 'RALE537',  // Raleigh-Cary, NC
  '39660': 'RAPI646',  // Rapid City, SD
  '39740': 'READ742',  // Reading, PA
  '39820': 'REDD806',  // Redding, CA
  '39900': 'RENO932',  // Reno, NV
  '40060': 'RICH051',  // Richmond, VA
  '40140': 'RIVE106',  // Riverside-San Bernardino-Ontario, CA
  '40220': 'ROAN251',  // Roanoke, VA
  '40340': 'ROCH327',  // Rochester, MN
  '40380': 'ROCH336',  // Rochester, NY
  '40420': 'ROCK417',  // Rockford, IL
  '40580': 'ROCK537',  // Rocky Mount, NC
  '40660': 'ROME613',  // Rome, GA
  '40900': 'SACR906',  // Sacramento-Roseville-Folsom, CA
  '40980': 'SAGI926',  // Saginaw, MI
  '41060': 'STCL027',  // St. Cloud, MN
  '41100': 'STGE149',  // St. George, UT
  '41140': 'STJO129',  // St. Joseph, MO-KS
  '41180': 'STL',      // St. Louis, MO-IL
  '41420': 'SALE441',  // Salem, OR
  '41500': 'SALI506',  // Salinas, CA
  '41540': 'SALI524',  // Salisbury, MD-DE
  '41620': 'SALT649',  // Salt Lake City, UT
  '41660': 'SANA648',  // San Angelo, TX
  '41700': 'SANA748',  // San Antonio-New Braunfels, TX
  '41740': 'SAND706',  // San Diego-Chula Vista-Carlsbad, CA
  '41860': 'SANF806',  // San Francisco-Oakland-Hayward, CA  ← manually corrected
  '41940': 'SANJ906',  // San Jose-Sunnyvale-Santa Clara, CA
  '42020': 'SANL006',  // San Luis Obispo-Paso Robles, CA
  '42100': 'SANT106',  // Santa Cruz-Watsonville, CA
  '42140': 'SANT135',  // Santa Fe, NM
  '42200': 'SANT006',  // Santa Maria-Santa Barbara, CA
  '42220': 'SANT206',  // Santa Rosa-Petaluma, CA
  '42340': 'SAVA313',  // Savannah, GA
  '42540': 'SCRA542',  // Scranton-Wilkes-Barre, PA
  '42660': 'SEAT653',  // Seattle-Tacoma-Bellevue, WA  ← manually added
  '42680': 'SEBA612',  // Sebastian-Vero Beach, FL
  '42700': 'SEBR912',  // Sebring-Avon Park, FL
  '43100': 'SHEB155',  // Sheboygan, WI
  '43300': 'SHER348',  // Sherman-Denison, TX
  '43340': 'SHRE322',  // Shreveport-Bossier City, LA
  '43420': 'SVSD904',  // Sierra Vista-Douglas, AZ
  '43580': 'SIOU519',  // Sioux City, IA-NE-SD
  '43620': 'SIOU646',  // Sioux Falls, SD
  '43780': 'SOUT718',  // South Bend-Mishawaka, IN-MI
  '43900': 'SPAR945',  // Spartanburg, SC
  '44060': 'SPOK053',  // Spokane-Spokane Valley, WA
  '44100': 'SPRI117',  // Springfield, IL
  '44140': 'SPRI125',  // Springfield, MA
  '44180': 'SPI',      // Springfield, MO
  '44220': 'SPRI239',  // Springfield, OH
  '44300': 'STAT342',  // State College, PA
  '44420': 'STWN951',  // Staunton, VA
  '44600': 'WEIR239',  // Weirton-Steubenville, WV-OH
  '44700': 'STOC706',  // Stockton, CA
  '44940': 'SUMT945',  // Sumter, SC
  '45060': 'SYRA036',  // Syracuse, NY
  '45220': 'TALL212',  // Tallahassee, FL
  '45300': 'TAMP312',  // Tampa-St. Petersburg-Clearwater, FL
  '45460': 'TERR418',  // Terre Haute, IN
  '45500': 'TEX',      // Texarkana, TX-Texarkana, AR
  '45540': 'VILL912',  // the Villages, FL
  '45780': 'TOLE739',  // Toledo, OH
  '45820': 'TOPE820',  // Topeka, KS
  '45940': 'TREN934',  // Trenton-Princeton, NJ
  '46060': 'TUCS004',  // Tucson, AZ
  '46140': 'TULS140',  // Tulsa, OK
  '46220': 'TUSC201',  // Tuscaloosa, AL
  '46340': 'TYLE348',  // Tyler, TX
  '46520': 'HONO115',  // Urban Honolulu, HI
  '46540': 'UTIC536',  // Utica-Rome, NY
  '46660': 'VALD613',  // Valdosta, GA
  '46700': 'VALL706',  // Vallejo, CA
  '47020': 'VICT048',  // Victoria, TX
  '47220': 'VINE234',  // Vineland-Bridgeton, NJ
  '47260': 'VIRG251',  // Virginia Beach-Norfolk-Newport News, VA-NC
  '47300': 'VISA306',  // Visalia, CA
  '47380': 'WACO348',  // Waco, TX
  '47460': 'WLWL953',  // Walla Walla, WA
  '47580': 'WARN513',  // Warner Robins, GA
  '47900': 'WASH911',  // Washington-Arlington-Alexandria, DC-VA-MD-WV  ← manually added
  '47940': 'WATE919',  // Waterloo-Cedar Falls, IA
  '48060': 'WFTD936',  // Watertown-Fort Drum, NY
  '48140': 'WAUS155',  // Wausau-Weston, WI
  '48300': 'WENA353',  // Wenatchee-East Wenatchee, WA
  '48540': 'WHEE554',  // Wheeling, WV-OH
  '48620': 'WICH620',  // Wichita, KS
  '48660': 'WICH648',  // Wichita Falls, TX
  '48700': 'WILL742',  // Williamsport, PA
  '48900': 'WILM937',  // Wilmington, NC
  '49020': 'WINC051',  // Winchester, VA-WV
  '49180': 'WINS137',  // Winston-Salem, NC
  '49340': 'WORC625',  // Worcester, MA-CT
  '49420': 'YAKI453',  // Yakima, WA
  '49620': 'YORK642',  // York-Hanover, PA
  '49660': 'YOUN639',  // Youngstown-Warren-Boardman, OH-PA
  '49700': 'YUBA706',  // Yuba City, CA
  '49740': 'YUMA704',  // Yuma, AZ
};

/**
 * STATE_FIPS: State abbreviation → 2-digit FIPS code.
 * Needed for BLS wages (SMU) series: SMU{stFIPS}{cbsa}0500000003SA
 */
const STATE_FIPS = {
  'AL': '01', 'AK': '02', 'AZ': '04', 'AR': '05', 'CA': '06',
  'CO': '08', 'CT': '09', 'DE': '10', 'DC': '11', 'FL': '12',
  'GA': '13', 'HI': '15', 'ID': '16', 'IL': '17', 'IN': '18',
  'IA': '19', 'KS': '20', 'KY': '21', 'LA': '22', 'ME': '23',
  'MD': '24', 'MA': '25', 'MI': '26', 'MN': '27', 'MS': '28',
  'MO': '29', 'MT': '30', 'NE': '31', 'NV': '32', 'NH': '33',
  'NJ': '34', 'NM': '35', 'NY': '36', 'NC': '37', 'ND': '38',
  'OH': '39', 'OK': '40', 'OR': '41', 'PA': '42', 'RI': '44',
  'SC': '45', 'SD': '46', 'TN': '47', 'TX': '48', 'UT': '49',
  'VT': '50', 'VA': '51', 'WA': '53', 'WV': '54', 'WI': '55',
  'WY': '56',
};

export { CITY_PREFIX_MAP, STATE_FIPS };
export default CITY_PREFIX_MAP;
