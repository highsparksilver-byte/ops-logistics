Ill add some stuff for reference - 

it says on bluedart portal - 


curl --location 'https://apigateway-sandbox.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct' \
--header 'content-type: application/json' \
--header 'JWTToken: REPLACE_KEY_VALUE' \
--data '{"pPinCodeTo":"string","pPickupTime":"string","pPinCodeFrom":"string","profile":{"LoginID":"string","Api_type":"T","LicenceKey":"string"},"pProductCode":"string","pPudate":"string","pSubProductCode":"s"}'


curl -X 'POST' \
  'https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct' \
  -H 'accept: application/json' \
  -H 'JWTToken: eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdWJqZWN0LXN1YmplY3QiLCJhdWQiOlsiYXVkaWVuY2UxIiwiYXVkaWVuY2UyIl0sImlzcyI6InVybjovL2FwaWdlZS1lZGdlLUpXVC1wb2xpY3ktdGVzdCIsImV4cCI6MTc2ODQwOTYwNSwiaWF0IjoxNzY4MzIzMjA1LCJqdGkiOiI5MGExZjQ2ZS00NzMzLTQ1OTAtODFjOS04YWUxZGNiYWZhZWMifQ.NIQDd34M0YDSbm5anjaEg0PXfK5Tn32Md9gguGQ5enI' \
  -H 'Content-Type: application/json' \
  -d '{
  "pPinCodeFrom": "411022",
  "pPinCodeTo": "400099",
  "pProductCode": "A",
  "pSubProductCode": "P",
  "pPudate": "/Date(1653571901000)/",
  "pPickupTime": "16:00",
  "profile": {
    "Api_type": "S",
    "LicenceKey": "oupkkkosmeqmuqqfsph8korrp8krmouj",
    "LoginID": "PNQ90609"
  }
}'


Request URL
https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct
