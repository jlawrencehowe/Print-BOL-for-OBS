/**
 *@NApiVersion 2.1
 *@NScriptType Suitelet

 By: Jacob Howe (Advantus)
 Date: 2020-06-12
 
 * Update: 2021/11/09 BSD-56648 - Merged BOL and Supp BOL functionalities (JLH)
 * Update: 2022/03/16 BSD-60099 - Added Hazard variables (JLH)
 * Update: 2022/08/02 PMA-60 - Refactored BOL generation to remove file saving outside of the final combined PDF to lower the governance cost. This allows more PDFs to generate before reaching that limit (JLH)

 Purpose: The purpose of this suitelet is to take in a given ADV - Outbound Shipment internal ID and then generate a BOL for it (by reading in the packing list BOL template referenced underneath the customer record
 */

define(['N/https','N/record', 'N/search', 'N/url', 'N/file', 'N/render','N/runtime', 'N/xml', 'N/format'],

    function(https, record, search, url, file, render,runtime, xml, format) { // NetSuite's AMD pattern
	
		const _PICKING = 1;		// ADV - Outbound Shipment Status

        function onRequest_entry(context) { // Suitelet entry function receives a context obj
            var scriptObj = runtime.getCurrentScript();
			var currentuser = runtime.getCurrentUser();
			
            var DEFAULT_BILLOFLADING = 183;		// internal id of the Advanced PDF/HTML Template to use when none is specified at the customer level
			var DEFAULT_BOLSUPPLEMENT = 573739;		// internal id of the document/file record for default supplemental BOL template
			var TEMP_PDF_FOLDER = 182580;
			var doPrintNodeReq = true;
			var combinedBOLFile;
			var combinedBOLFileId;
			xmlTemplateFile = file.load(DEFAULT_BOLSUPPLEMENT);
			
			var myMode;
			var myPrinter;
			var myQty;
			if (context.request.parameters.mode) {
				myMode = "external";
				myPrinter = context.request.parameters.ltrprnt;
				myQty = parseInt(context.request.parameters.bolqty);
			} else {
				myMode = "regular";
				
				// Looks up default printer information for the user
				if (!!currentuser) {
					var empData = search.lookupFields({ type: search.Type.EMPLOYEE, id: currentuser.id, columns: 'custentity_adv_emp_pn_letterprinter' });
					
					try{
						var pnPrintData = search.lookupFields({
							type: 'customrecord_adv_pn_printers',
							id: empData.custentity_adv_emp_pn_letterprinter[0].value,
							columns: 'custrecord_adv_pn_printerid'
						});
						
						myPrinter = pnPrintData.custrecord_adv_pn_printerid;
					}
					catch(e){
						log.audit('No PrintNode Letter Printer Set for User - '+currentuser, e);
					}
				}
			}
			
			myPrinter = getPrintNodePrinterId(myPrinter);	// grab PrintNode printer id from the internal id of the ADV - PrintNode Printer record
				
			// Grab the value stored in the URL parameter rid
            //var myId = context.request.parameters.rid;
			var myId;
			try{
				var myId = JSON.parse(context.request.parameters.recid);	
			}
			catch{
				var tempJson = [];
				tempJson.push(context.request.parameters.rid);
				tempJson = JSON.stringify(tempJson);
				var myId = JSON.parse(tempJson);
			}
			var docIds = [];
			var bolTemplates = [];
			var multiPDF = "<?xml version=\"1.0\"?><!DOCTYPE pdf PUBLIC \"-//big.faceless.org//report\" \"report-1.1.dtd\">\r\n<pdfset>";
			for(var i = 0; i < myId.length; i++){
				
			log.audit('Remaining governance units1: ' + scriptObj.getRemainingUsage());
		
				//log.debug('OBS', 'Grabbed OBS: ' + myId);

				
				// Load OBS
				var myShipment = search.lookupFields({
					type: 'customrecord_adv_out_shipment',
					id: myId[i],
					columns: ['custrecord_adv_shp_customer', 'custrecord_adv_shp_status','name', 'custrecord_adv_shp_bol_template', 'custrecord_adv_shp_actual_shipvia_map', 'custrecord_adv_shp_cust_prov_bol', 'custrecord_adv_shp_bol_carrier_comm_1', 'custrecord_adv_shp_bol_ord_no_1','custrecord_adv_shp_3rdparty_freight_rule', 'custrecord_adv_shp_freight_pay_code']
				});
				
				
				
				log.debug('Shipment JSON', JSON.stringify(myShipment));
				
				// Check to see if this is the firs time we are printing this BOL.  If it is, we will not print via PrintNode
				if(myId.length == 1) {
					var fileSearchObj = search.create({
					type: "file",
					filters:
					[
						["folder","anyof",TEMP_PDF_FOLDER], 	
						"AND", 
						["name","is","BOL_" + myShipment.name + ".pdf"]
					],
					columns:
					[
						search.createColumn({name: "internalid"})
					]
					});
					var searchResultCount = fileSearchObj.runPaged().count;
					if (searchResultCount > 0) {
						doPrintNodeReq = false;
					}	
				}
				else{
					doPrintNodeReq = false;
				}
				
				//Update: 2021/11/09 BSD-56648
				var yesSupp = '0';
				if (myShipment.custrecord_adv_shp_bol_carrier_comm_1 == "See Supplemental Pages" || myShipment.custrecord_adv_shp_bol_ord_no_1 == "See Supplemental Pages") {
					var yesSupp = '1';
				}
				
				// Grab customer and Status
				var myCust = myShipment.custrecord_adv_shp_customer[0] ? myShipment.custrecord_adv_shp_customer[0].value : '';
				var myStatus = myShipment.custrecord_adv_shp_status[0] ? myShipment.custrecord_adv_shp_status[0].value : '';
				var myShipmentBOL = myShipment.custrecord_adv_shp_bol_template[0] ? myShipment.custrecord_adv_shp_bol_template[0].value : '';
				var myCustomerBOL = myShipment.custrecord_adv_shp_cust_prov_bol[0] ? myShipment.custrecord_adv_shp_cust_prov_bol[0].value : '';
				var mySVMId = myShipment.custrecord_adv_shp_actual_shipvia_map[0] ? myShipment.custrecord_adv_shp_actual_shipvia_map[0].value : '';
				var myThirdPartyRule = myShipment.custrecord_adv_shp_3rdparty_freight_rule[0] ? myShipment.custrecord_adv_shp_3rdparty_freight_rule[0].value : '';
				var myFreightPayCode = myShipment.custrecord_adv_shp_freight_pay_code;		// this is a free form text field on the OBS
				
				log.debug('OBS', 'Grabbed OBS: ' + myId[i] + ' ... Entity ID: ' + myCust + ' ... Name: '+ myShipment.name + ' ... SVM Id: ' + mySVMId);
				log.debug('myCustomerBOL', myCustomerBOL);

				// If we wanted to do any validation on the status we could do it here (e.g. not allow BOL to be printed if Status is <something>
				var svmLookup = search.lookupFields({
					type: 'customrecord_adv_shipvia_mapping',
					id: mySVMId,
					columns: ['custrecord_adv_svm_donotallowbookship']
				});
					
				if (svmLookup.custrecord_adv_svm_donotallowbookship) {
					context.response.write('<html><body>Error! This Ship Via is not a valid Ship Via for Booking or Shipping therefore a Bill of Lading cannot be generated.  Please choose a valid ship via and try again.</body></html>');
					return;
				}
				
				if (myStatus == _PICKING) {
					context.response.write('<html><body>Error! BOL cannot be generated while Shipment is in a PICKING status.</body></html>');
					return;
				}
				
				// BSD-62319 - KK - 2022-07-08 - Do not allow freight pay code of Third Party Billing with a null/empty ADV - BOL Instruction/3rd Party Billing record set on the OBS
				if (myFreightPayCode == "Third Party Billing" && myThirdPartyRule.length == 0) {
					context.response.write('<html><body>Error! A Freight Pay Code of Third Party Billing cannot be specified without a Third Party Rule defined on the Outbound Shipment record.</body></html>');
					return;
				}
				
				// end validation

				// Grab BOL template underneath customer record
				var custData = search.lookupFields({
					type: search.Type.CUSTOMER,
					id: myCust,
					columns: ['custentity_adv_cust_doc_bol_template', 'custentity_adv_cust_custbol_suitelet_dep', 'custentity_adv_cust_custbol_suitelet_scr']
				});
				var myTemplate = custData.custentity_adv_cust_doc_bol_template[0] ? custData.custentity_adv_cust_doc_bol_template[0].value : '';
				var myCustomSuiteletDeploy = custData.custentity_adv_cust_custbol_suitelet_dep ? custData.custentity_adv_cust_custbol_suitelet_dep : '';
				var myCustomSuiteletScript = custData.custentity_adv_cust_custbol_suitelet_scr ? custData.custentity_adv_cust_custbol_suitelet_scr : '';
				
				// START BSD-60699 - KJK - 2022-04-13 - Capture timestamp of when BOL was printed
				var myDate = new Date();
				var formattedDateString = format.format({
					value: myDate,
					type: format.Type.DATETIMETZ
                });
				record.submitFields.promise({
					  type: 'customrecord_adv_out_shipment',
					  id: myId[i],
					  values: {
						   custrecord_adv_obs_bolprint_timestamp: formattedDateString
					   },
				});
				// END BSD-60699
			  
				// if BOL is set at the shipment level, use that over Customer BOL.  Priority should be Customer Provided PDF > Shipment BOL > Customer BOL > Default BOL
				
				var bolFile
				if(!!myCustomerBOL){
					bolFile = myCustomerBOL;
					bolFileId = myCustomerBOL;
					// Try to see if the file already exists in the filing cabinet.  If it does, simply display it in lieu of regenerating it. 
					//This only matters/works if there is a single document as multi-docs are not saved
					if(myId.length == 1){
						try {
							record.delete({
								record: {
									type: 'file',
									id:	bolFile
								},
								from: {
									type: 'customrecord_adv_out_shipment',
									id: myId[i]
								}
							})
							
							doPrintNodeReq = false;
											
						} catch (e) {
							log.debug('Bill of Lading not found 2', e);
							doPrintNodeReq = true;
						}
					}
					else{
						doPrintNodeReq = false;
					}
				}
				else if (!!myShipmentBOL) {
					  myTemplate = myShipmentBOL;
					
				}
				if(!myCustomerBOL){
					// Read in template file
					if (myTemplate) {
						log.debug("Load Customer Template", myTemplate);
					} else {
						// change this and put in the default template at some point...
						log.debug("Load DEFAULT Template", DEFAULT_BILLOFLADING);
					}
					
					// Redirect to custom BOL Suitelet if one is defined
					if (!!myCustomSuiteletDeploy && !!myCustomSuiteletScript) {
						var myParams = {
							"rid": myId[i]
						};
						
						context.response.sendRedirect('SUITELET', myCustomSuiteletScript, myCustomSuiteletDeploy, false, myParams);
						return;		
					}
					

					// Merge the current record into the template
					var renderer = render.create();
					var obsRecord = record.load({
						type: 'customrecord_adv_out_shipment',
						id: +myId[i]
					});
					renderer.setTemplateById(+myTemplate);
					renderer.addRecord('record', obsRecord);
					log.debug('obsRecord', obsRecord);
					
					
					// Create a PDF document from the BOL Template
					bolFile = renderer.renderAsString();
					
					//remove leading XML string to append to multi-pdf variable
                    bolFile = bolFile.replace('<?xml version=\"1.0\"?><!DOCTYPE pdf PUBLIC \"-//big.faceless.org//report\" \"report-1.1.dtd\">', "");
					multiPDF += bolFile;
					
					//Creates the merged BOL file pdf and removes temporary files
					//Update: 2021/11/09 BSD-56648
					if(yesSupp == '1'){
						var suppFile = PrintSupplementBOL(myId[i], myShipment, obsRecord, i, xmlTemplateFile);
						
						suppFile = suppFile.replace('<?xml version=\"1.0\"?><!DOCTYPE pdf PUBLIC \"-//big.faceless.org//report\" \"report-1.1.dtd\">', "");
						multiPDF += suppFile;
					}
					
					
				}
			
				log.audit('Remaining governance units2: ' + scriptObj.getRemainingUsage());
			}
			
			multiPDF += "</pdfset>";
			log.debug('multiPDF', multiPDF);
			 var document = xml.Parser.fromString({
                text : multiPDF
            });

            var pdfFile = render.xmlToPdf({
                xmlString:document
            });
			combinedBOLFile = pdfFile;
			combinedBOLFile.name = "CombinedBOL_" + myShipment.name + ".pdf";
			combinedBOLFile.folder = TEMP_PDF_FOLDER;
			combinedBOLFile.isOnline = true;
			combinedBOLFileId = combinedBOLFile.save();
			log.debug("Combined BOL Generated - " + combinedBOLFileId);
			if(myId.length == 1){
				// Attach the BOL file to the Outbound Shipment record
					record.attach({
						record: {
							type: 'file',
							id: combinedBOLFileId
						},
						to: {
							type: 'customrecord_adv_out_shipment',
							id: myId[0]
						}
					});
			}
			
				

			
			if (myMode == "regular" && !!combinedBOLFile) {
				// regular mode = called from a button or viewed in browser
				log.debug("REGULAR Mode Called - " + myId, "PN Printer: " + myPrinter);
				if (!!myPrinter && doPrintNodeReq) {
					sendPrintNodeRequest(myPrinter, "BOL_IntM_"+ myShipment.name, combinedBOLFile.getContents(), 1);
				}
				context.response.writeFile(combinedBOLFile, true);
			} else if (myMode == "external" && myQty > 0) {
				log.debug("EXTERNAL Mode Called - " + myId, "PN Printer: " + myPrinter);
				sendPrintNodeRequest(myPrinter, "BOL_ExtM_"+ myShipment.name, combinedBOLFile.getContents(), myQty);
			}

			log.audit('Remaining governance units3: ' + scriptObj.getRemainingUsage());
			
            
        }



        return {
            onRequest: onRequest_entry // Function assigned to entry point
        };
		
		
		function PrintSupplementBOL(myId, myShipment, obsRecord, iteration, defaultBOLSUPP){
			var CUSTOMER_ORDER_INFO_SEARCH  = 2571;		// Search name: ***SCRIPT - LPs for BOL Customer Order Information (PG)
			var CARRIER_INFO_SEARCH         = 2572;				// Search name: ***SCRIPT - LPs for BOL Carrier Information (PG)
			var TEST_INFO_SEARCH         = 'customsearch_bol_customer_order_info_3';				// Search name: ***SCRIPT - LPs for BOL Customer Order Information Test (JLH)
			var TEMP_PDF_FOLDER = 182580;
			
			// Grab the value stored in the URL parameter rid
           
							
			// Grab customer and Status
			var myStatus = myShipment.custrecord_adv_shp_status[0] ? myShipment.custrecord_adv_shp_status[0].value : '';
			
			
			xmlTemplateFile = defaultBOLSUPP;
			
			var templateContent = xmlTemplateFile.getContents();
			
			
			// ---START: Saved search to load Customer Order Information
			var mySearch = search.load({
				id: CUSTOMER_ORDER_INFO_SEARCH				
			});
			
			// Copy the filters from mySearch into defaultFilters
			var defaultFilters = mySearch.filters;
			customFilters = search.createFilter({name: "internalid", join: "custrecord_adv_shipment_number", operator: search.Operator.ANYOF, values: myId});
			
			var allFilters = defaultFilters.concat(customFilters);
			mySearch.filters = allFilters;					// Copy the modified defaultFilters back into mySearch
			var rs = mySearch.run();
			
			
			// ---START: Saved search to load Carrier Information
			mySearch = search.load({
				id: CARRIER_INFO_SEARCH				
			});
			
			// Copy the filters from mySearch into defaultFilters
			defaultFilters = mySearch.filters;
			customFilters = search.createFilter({name: "internalid", join: "custrecord_adv_shipment_number", operator: search.Operator.ANYOF, values: myId});
			
			allFilters = defaultFilters.concat(customFilters);
			mySearch.filters = allFilters;					// Copy the modified defaultFilters back into mySearch
			var rs2 = mySearch.run();
			
			if (rs && rs2) {
				var results = rs.getRange(0, 1000); // If we ever ship >1000 POs on an order this will be a problem.  But that's high unlikely
				var results2 = rs2.getRange(0, 1000); // If we ever ship >1000 NMFC does on an order this will be a problem.  But that's high unlikely
				
				var renderer = render.create();
				
				var myData;
				var custOrderData = [];
				var newObj = {};
				var carrierInfoData = [];
				//log.debug("RAW Results", JSON.stringify(results));
				
				
				// sanitize Customers orders results object for easier display in XML (no parenthesis because freemarker)
				for (var x = 0; x < results.length; x++) {
					myData = JSON.stringify(results[x]);		
					//log.debug("CustOrders", myData);
					obj = JSON.parse(myData);
					
					
					
					if (obj.values["GROUP(CUSTRECORD_RFS_LP_HEADER_PROPERTIES.custrecord_adv_license_plate_type)"][0].value != "1") {	// only count cartons
						newObj = {};
						newObj.ordernumber = obj.values["GROUP(formulatext)"];
						newObj.pkgcount = obj.values["COUNT(name)"];
						newObj.grossweight = obj.values["SUM(custrecord_adv_lp_gross_weight_lbs)"];
						newObj.shipperinfo = obj.values["GROUP(formulatext)_1"];
						
						
						
						custOrderData.push(newObj);
					}
					
					
				}			
				//log.debug("KJK custOrderData", JSON.stringify(custOrderData));		
				var dataResult = {};
				dataResult["custOrderData"] = custOrderData;
				dataResult["carrierInfoData"] = carrierInfoData;
				// Finally let's add the santizied object to the template
				renderer.templateContent = templateContent;
				renderer.addCustomDataSource({
					format: render.DataSource.OBJECT,
					alias: 'custorders',		// This is the object name used in the template file (XML) that references this resultset
					data: dataResult
				});
				
				
				// sanitize carrier information object for easier display in XML (no parenthesis because freemarker)
				carrierInfoData = [];
				
				for (var x = 0; x < results2.length; x++) {
					myData = JSON.stringify(results2[x]);		
					//log.debug("CarrierInfo", myData);
					obj = JSON.parse(myData);
					newObj = {};
					
					if (obj.values["GROUP(CUSTRECORD_RFS_LP_HEADER_PROPERTIES.custrecord_adv_license_plate_type)"][0].text == "Carton") {
						newObj.handlingqty = 0;
						newObj.handlingtype = '';
						newObj.pkgqty = obj.values["SUM(formulanumeric)"];
						newObj.pkgtype = 'CTN';
						newObj.grossweight = obj.values["SUM(custrecord_adv_lp_gross_weight_lbs)"];
					} else {
						newObj.handlingqty = obj.values["SUM(formulanumeric)"];
						newObj.handlingtype = 'PLT';
						newObj.pkgqty = 0;
						newObj.pkgtype = '';
						newObj.grossweight = obj.values["SUM(CUSTRECORD_RFS_LP_HEADER_PROPERTIES.custrecord_rfs_lp_properties_weight)"];
					}
					if(obj.values["GROUP(CUSTRECORD_ADV_LPH_NMFC_TYPE.custrecord_adv_nmfc_hazardous)"]){
						log.debug("Is Harzardous", obj.values["GROUP(CUSTRECORD_ADV_LPH_NMFC_TYPE.custrecord_adv_nmfc_hazardous)"]);
						newObj.hazardous = obj.values["GROUP(CUSTRECORD_ADV_LPH_NMFC_TYPE.custrecord_adv_nmfc_hazardous)"];
					}
					else{
						newObj.hazardous = '';
					}
					newObj.commoditydesc = obj.values['GROUP(formulatext)'];
					newObj.nmfc = obj.values['GROUP(formulatext)_1'];
					newObj.itemclass = obj.values['GROUP(formulanumeric)'];
						
					carrierInfoData.push(newObj);				
				}			
				//log.debug("KJK CarrierInfo", JSON.stringify(carrierInfoData));
				dataResult = {};
				dataResult["carrierInfoData"] = carrierInfoData;
				
				renderer.addCustomDataSource({
					format: render.DataSource.OBJECT,
					alias: 'carrierinfo',		// This is the object name used in the template file (XML) that references this resultset
					data: dataResult
				});
				
				renderer.addRecord({
					templateName: 'srecord',
					record: obsRecord
				});
				
				
				// Create a pdf document
				//var bolFile = renderer.renderAsPdf();
				var bolFile = renderer.renderAsString();
				
				return bolFile;
			}
		}
		
		//Update: 2021/11/09 BSD-56648
		//Merges two PDF files and returns the new file
		function renderSet(opts){
			var tpl = ['<?xml version="1.0"?>','<pdfset>'];

			
			var base = xml.Parser.fromString(opts[0])
			for(var i = 0; i < opts.length; i++){
			log.audit('opts[i].url', opts[i]);
				var test = xml.Parser.fromString(opts[i]);
			log.audit('test', test);
			log.audit('test2', test.documentElement);
			var test2 = base.importNode(test.documentElement, false);
			}
			return render.xmlToPdf(test2);
			
			
		}
		
		// Function: sendPrintNodeRequest
		// Purpose: Generates a HTTPS POST request to PrintNode
		// Inputs: 
		//		* pnId = PrintNode Printer ID
		//		* pnTitle = Title of PrintNode Request
		//		* fileContents = Base64 encoded contents of file we want to automatically print
		//		* myQty = Quantity of prints we want to send
		// Outputs: Returns true if request was successful ... false if not
		function sendPrintNodeRequest(pnId, pnTitle, fileContents, myQty) {
			var isSuccess;
			
			log.debug("sendPrintNodeRequest - pnId | pnTitle", pnId + " | " + pnTitle);
			
			if (!pnId) {
				log.audit("sendPrintNodeRequest", "Invalid PrintNode Printer - Exiting");
				return;
			}
			
			// Sends a FilePrint Request to PrintNode
			var pnbody = {
				printerId: pnId,
				title: pnTitle,
				contentType: 'pdf_base64',
				content: fileContents,
				qty: myQty,
				source: 'ADV NS Status Change Suitelet'
			};

			try {
				headers = {
					'Content-Type': 'application/json',
					'Authorization': 'Basic dDZ2dlBfdUZtMzN4cm4zMVBnVkMyVEl0c1VWOC1NVHFXY0kwbmFNMU8zUTo'
				};
				resp = https.post.promise({
					url: 'https://api.printnode.com/printjobs',
					body: JSON.stringify(pnbody),
					headers: headers
				});
				isSuccess = true;
			}
			catch (e) {
				log.error('sendPrintNodeRequest - PrintNode ERROR', e);
				isSuccess = false;
			}
			
			return isSuccess;
		}
		
		// Function: getPrintNodePrinterId
		// Inputs: myPrinter = Internal id of ADV - PrintNode Printer record
		// Outputs: Returns Printnode Printer Id
		function getPrintNodePrinterId(myPrinter) {
			 
			 if (!myPrinter) {
				 return null;
			 }
			 
			 var pnData = search.lookupFields({
				 type: "customrecord_adv_pn_printers", 
				 id: myPrinter, 
				 columns: [
					"custrecord_adv_pn_printerid"
				]
			});
			
			return pnData.custrecord_adv_pn_printerid;
		}
    }
);