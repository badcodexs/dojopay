import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

declare global {
  interface Window {
    FB: any;
    fbAsyncInit: () => void;
  }
}

export const Dashboard = () => {
  const navigate = useNavigate();
  const [isFbLoaded, setIsFbLoaded] = useState(false);
  const [status, setStatus] = useState('');
  const businessName = localStorage.getItem('business_name') || 'Academia';

  const [isConnected, setIsConnected] = useState(localStorage.getItem('is_connected') === 'true');

  useEffect(() => {
    if (isConnected) return;

    window.fbAsyncInit = function() {
      window.FB.init({
        appId: import.meta.env.VITE_META_APP_ID,
        cookie: true,
        xfbml: true,
        version: 'v20.0'
      });
      setIsFbLoaded(true);
    };

    (function(d, s, id) {
      let js: any, fjs = d.getElementsByTagName(s)[0];
      if (d.getElementById(id)) return;
      js = d.createElement(s); js.id = id;
      js.src = "https://connect.facebook.net/en_US/sdk.js";
      if(fjs && fjs.parentNode) fjs.parentNode.insertBefore(js, fjs);
    }(document, 'script', 'facebook-jssdk'));
  }, [isConnected]);

  const handleLogout = () => {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('business_name');
    localStorage.removeItem('is_connected');
    navigate('/login');
  };

  const handleConnect = () => {
    if (!window.FB) return;
    setStatus('Conectando con Meta...');

        window.FB.login((response: any) => {
      if (response.authResponse) {
        const accessToken = response.authResponse.accessToken;
        const payload = {
          metaAccessToken: accessToken,
          metaWabaId: response.authResponse.waba_id || 'PENDING_WABA_ID',
          metaPhoneNumberId: response.authResponse.phone_number_id || 'PENDING_PHONE_ID'
        };
        sendToBackend(payload);
      } else {
        setStatus('El usuario canceló el inicio de sesión o no lo autorizó.');
      }
    }, {
      scope: 'whatsapp_business_management,whatsapp_business_messaging',
      extras: {
        feature: 'whatsapp_embedded_signup',
        setup: {}
      }
    });
  };

  const sendToBackend = async (payload: any) => {
    try {
      setStatus('Cifrando y guardando credenciales...');
      const token = localStorage.getItem('jwt_token');
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';

      const res = await fetch(`${apiUrl}/api/meta/callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setIsConnected(true);
      localStorage.setItem('is_connected', 'true');
      setStatus('');
    } catch (err: any) {
      setStatus('Error al guardar credenciales: ' + err.message);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-8 py-4 flex justify-between items-center">
        <h1 className="text-xl font-bold text-gray-900">DojoPay Panel</h1>
        <button onClick={handleLogout} className="text-sm text-gray-600 hover:text-gray-900 font-medium">
          Cerrar Sesión
        </button>
      </nav>

      <main className="max-w-4xl mx-auto mt-12 p-8 bg-white rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Bienvenido, {businessName}</h2>
        <p className="text-gray-600 mb-8">Administra la configuración de tu bot y WhatsApp.</p>

        {isConnected ? (
          <div className="bg-green-50 border border-green-200 rounded-lg p-8 flex flex-col items-center justify-center">
            <svg className="w-16 h-16 text-green-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            <h3 className="text-xl font-bold text-green-900 mb-2">WhatsApp Conectado</h3>
            <p className="text-sm text-green-700 text-center max-w-md">
              Tu línea oficial ya está vinculada a DojoPay. Nuestro bot está gestionando tus recordatorios y conversaciones de forma automática.
            </p>
          </div>
        ) : (
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-8 flex flex-col items-center justify-center">
            <div className="text-center mb-6">
              <h3 className="text-xl font-bold text-blue-900">Conectar WhatsApp Oficial</h3>
              <p className="text-sm text-blue-700 mt-2 max-w-md mx-auto">Vincula tu número en 1 clic gracias a nuestra alianza con Meta para comenzar a enviar recordatorios automáticos.</p>
            </div>

            <button
              onClick={handleConnect}
              disabled={!isFbLoaded}
              className="flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-lg text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>
              Conectar WhatsApp
            </button>

            {status && (
              <p className="mt-4 text-sm font-medium text-blue-800 text-center">
                {status}
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
};
