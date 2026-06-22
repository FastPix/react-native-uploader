import axios from 'axios';
import base64 from 'base-64';
import {Constants } from '../Constants/ApiKeys';

interface UploadResponse {
  url: string;
  uploadId: string;
}

class ApiService {
 
  private static BASE_URL = Constants.Base_Api_Url;
  private static ACCESS_TOKEN_ID = Constants.Access_Token_Id
  private static SECRET_KEY = Constants.Secret_Key;

  // Generates the Basic Auth header string
  private static getAuthHeader(): string {
    const credentials = `${this.ACCESS_TOKEN_ID}:${this.SECRET_KEY}`;
    const basicAuthCredential = base64.encode(credentials);
    return `Basic ${basicAuthCredential}`;
  }

  
  // Creates a direct upload link with FastPix
  public static async createDirectUpload(): Promise<UploadResponse | null> {
    const url = `${this.BASE_URL}/upload`;

    const parameters = {
      corsOrigin: "*",
      pushMediaSettings: {
        accessPolicy: "public",
        generateSubtitles: true,
        normalizeAudio: true,
        maxResolution: "1080p",
      }
    };

    try {
      const response = await axios.post(url, parameters, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': this.getAuthHeader(),
        },
      });

      const dataDic = response.data?.data;
      console.log(`response : ${dataDic}`);
      
      if (dataDic && dataDic.uploadId && dataDic.url) {
          console.log(`got the upload details: ${dataDic.url} : ${dataDic.uploadId}`);
        return {
          url: dataDic.url,
          uploadId: dataDic.uploadId,
        };
      }
        console.log(`got nothing returning null : ${dataDic}`);
      return null;

    } catch (error: any) {
      if (error.response) {
        const statusCode = error.response.status;
        const errorMessage = typeof error.response.data === 'string' 
          ? error.response.data 
          : JSON.stringify(error.response.data);
          
        console.error(`Upload POST failed: HTTP ${statusCode}:\n${errorMessage}`);
      } else {
        console.error("CreateUploadError:", error.message);
      }
      throw error;
    }
  }

}

export default ApiService;
